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

  it('reconnects when the SDK stream drains on its own while still running, so a later push is not lost', async () => {
    // Simulates the reported bug: a resumed session's underlying SDK stream
    // completes on its own after replaying history and finishing one turn —
    // WITHOUT the caller (ClaudeSession) ever closing the prompt queue. The
    // pre-fix runLoop() treats any drain as "done" and returns, so a later
    // push() would sit in the queue with nothing consuming it — no error,
    // no reply, forever. The fix must reconnect instead.
    const received: string[] = [];
    const queryFn = vi.fn((args: any) => {
      const prompt = args.prompt as AsyncIterable<any>;
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
        // Consume exactly one message, reply, then end the generator on this
        // connection — mirroring the SDK ending its stream after one turn
        // while `prompt` stays open.
        for await (const msg of prompt) {
          const content = msg.message?.content ?? msg.text;
          received.push(typeof content === 'string' ? content : JSON.stringify(content));
          yield { type: 'result', subtype: 'success', session_id: 'sess-1', result: 'ok' };
          return;
        }
      })();
    });

    const s = new ClaudeSession(queryFn as any, {}, () => {});
    s.start('first');

    // First connection: consumes the initial message, then drains.
    await vi.waitFor(() => expect(received).toContain('first'));
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    // Give runLoop a tick to notice the drain and (queue now empty) park in
    // waitForWork() rather than returning.
    await new Promise((r) => setTimeout(r, 0));

    // An operator follow-up arrives well after the drain. Without the fix,
    // runLoop() already returned after the first drain, so nothing is
    // consuming `this.queue` anymore — this would be the reported bug
    // (silent worker, zero errors, follow-ups never answered).
    s.push('operator follow-up');

    // With the fix: draining while `running` re-issues queryFn() ...
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
    // ...and the pushed message actually reaches the new stream.
    await vi.waitFor(() => expect(received).toContain('operator follow-up'));

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

  it('stop() aborts a hung turn and does not report it as an error', async () => {
    // A query that hangs until its abort signal fires (a stuck worker).
    let sawAbort = false;
    const hangingQuery = ((args: any) => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      const signal = args.options?.abortController?.signal as AbortSignal | undefined;
      await new Promise<void>((resolve) => {
        if (signal?.aborted) { sawAbort = true; return resolve(); }
        signal?.addEventListener('abort', () => { sawAbort = true; resolve(); });
      });
      throw new Error('aborted'); // SDK surfaces an abort as a throw
    })()) as any;

    let errored: unknown;
    const s = new ClaudeSession(hangingQuery, {}, () => {}, (e) => { errored = e; });
    s.start('do a long thing');
    await vi.waitFor(() => expect(s.sessionId).toBe('sess-1'));
    s.stop();
    await vi.waitFor(() => expect(sawAbort).toBe(true));
    // give the loop a tick to run its catch
    await new Promise((r) => setTimeout(r, 0));
    expect(errored).toBeUndefined();
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
