import { describe, it, expect, vi } from 'vitest';
import { ClaudeSession } from '../src/session.js';

// A fake query() that echoes: records every user message it receives from the
// input iterable, and emits one result message carrying a session_id.
function makeFakeQuery(received: string[]) {
  return ((args: any) => {
    return (async function* () {
      const prompt = args.prompt as AsyncIterable<any>;
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      for await (const msg of prompt) {
        // documented shape: { type:'user', message:{ role:'user', content } }
        const content = msg.message?.content ?? msg.text;
        received.push(typeof content === 'string' ? content : JSON.stringify(content));
        yield { type: 'result', subtype: 'success', session_id: 'sess-1', result: 'ok' };
      }
    })();
  }) as any;
}

describe('ClaudeSession', () => {
  it('sends the initial message and captures the session id', async () => {
    const received: string[] = [];
    let capturedId: string | undefined;
    const s = new ClaudeSession(makeFakeQuery(received), {}, (id) => { capturedId = id; });
    s.start('hello');
    await vi.waitFor(() => expect(received).toContain('hello'));
    await vi.waitFor(() => expect(capturedId).toBe('sess-1'));
    expect(s.sessionId).toBe('sess-1');
  });

  it('push enqueues further messages into the same session', async () => {
    const received: string[] = [];
    const s = new ClaudeSession(makeFakeQuery(received), {}, () => {});
    s.start('first');
    await vi.waitFor(() => expect(received).toContain('first'));
    s.push('second');
    await vi.waitFor(() => expect(received).toContain('second'));
    s.stop();
  });

  // A query that rejects with a usage-limit error the first `failTimes` times it
  // is established, then behaves normally (yields session id, echoes messages).
  function flakyQuery(received: string[], failTimes: number, err: unknown) {
    let calls = 0;
    return ((args: any) => (async function* () {
      calls++;
      if (calls <= failTimes) throw err;
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      for await (const msg of args.prompt as AsyncIterable<any>) {
        const content = msg.message?.content ?? msg.text;
        received.push(typeof content === 'string' ? content : JSON.stringify(content));
        yield { type: 'result', subtype: 'success', session_id: 'sess-1', result: 'ok' };
      }
    })()) as any;
  }

  it('recovers from a usage-limit error: pauses, resumes, keeps processing', async () => {
    const received: string[] = [];
    const reset = Math.floor(new Date('2026-08-20T15:00:00Z').getTime() / 1000);
    const pauses: (Date | undefined)[] = [];
    let resumed = 0;
    const q = flakyQuery(received, 1, new Error(`Claude AI usage limit reached|${reset}`));
    const s = new ClaudeSession(q, { wait: () => Promise.resolve() }, () => {}, () => {},
      (resetAt) => pauses.push(resetAt), () => { resumed++; });
    s.start('hello');
    await vi.waitFor(() => expect(received).toContain('hello')); // survived the limit
    await vi.waitFor(() => expect(resumed).toBe(1));
    expect(pauses[0]?.toISOString()).toBe('2026-08-20T15:00:00.000Z');
    s.stop();
  });

  it('a non-limit error is terminal: onError fires, no pause/retry', async () => {
    const received: string[] = [];
    let errored: unknown;
    const pauses: unknown[] = [];
    const q = flakyQuery(received, 99, new Error('getaddrinfo ENOTFOUND host'));
    const s = new ClaudeSession(q, { wait: () => Promise.resolve() }, () => {},
      (e) => { errored = e; }, (r) => pauses.push(r));
    s.start('hello');
    await vi.waitFor(() => expect(errored).toBeInstanceOf(Error));
    expect((errored as Error).message).toMatch(/ENOTFOUND/);
    expect(pauses).toEqual([]);
    expect(received).toEqual([]);
    s.stop();
  });

  it('pauses with an undefined reset when the limit carries no time (backoff)', async () => {
    const received: string[] = [];
    const pauses: (Date | undefined)[] = [];
    const q = flakyQuery(received, 1, new Error('HTTP 429 Too Many Requests'));
    const s = new ClaudeSession(q, { wait: () => Promise.resolve() }, () => {}, () => {},
      (resetAt) => pauses.push(resetAt), () => {});
    s.start('hi');
    await vi.waitFor(() => expect(received).toContain('hi'));
    expect(pauses[0]).toBeUndefined();
    s.stop();
  });
});
