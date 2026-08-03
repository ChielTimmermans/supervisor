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
});
