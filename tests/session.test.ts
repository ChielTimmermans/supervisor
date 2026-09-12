import { describe, it, expect, vi } from 'vitest';
import { ClaudeSession, MessageQueue } from '../src/session.js';

describe('MessageQueue', () => {
  it('push() delivers to the most recently registered consumer, not an earlier one abandoned mid-read', async () => {
    // Real incident (2026-09-11): a ClaudeSession reconnects by abandoning the
    // current connection's generator without it ever finishing its last
    // `iterator.next()` call on the prompt queue — the real SDK keeps calling
    // `.next()` in a loop to forward each input item to the CLI subprocess's
    // stdin, so that abandoned call leaves a resolver sitting in the queue
    // forever. Two such abandoned reconnects, then two real operator
    // messages: both got silently swallowed by the two dead connections
    // instead of reaching the third (live) one still actually reading.
    const q = new MessageQueue<string>();

    // Two abandoned consumers, each with a permanently-pending `.next()` call
    // (nothing ever queued for them) — exactly what a connection that's been
    // reconnected-away-from leaves behind.
    const abandoned1 = q[Symbol.asyncIterator]().next();
    const abandoned2 = q[Symbol.asyncIterator]().next();

    // The live (3rd) consumer registers last.
    const live = q[Symbol.asyncIterator]().next();

    q.push('the real operator message');

    await expect(live).resolves.toEqual({ value: 'the real operator message', done: false });

    // The two abandoned reads must NOT have received it — they should still
    // be (harmlessly) pending, not resolved with a message meant for the
    // live connection.
    const raced = await Promise.race([
      Promise.all([abandoned1, abandoned2]).then(() => 'abandoned-resolved'),
      new Promise((r) => setTimeout(() => r('still-pending'), 20)),
    ]);
    expect(raced).toBe('still-pending');
  });

  it('push() still delivers normally when there is only ever one consumer', async () => {
    const q = new MessageQueue<string>();
    const first = q[Symbol.asyncIterator]().next();
    q.push('hello');
    await expect(first).resolves.toEqual({ value: 'hello', done: false });
  });
});

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

  it('drainAndStop waits for a buffered message to actually reach the model before closing, instead of discarding it', async () => {
    // Real incident: a SIGHUP self-reload raced a push() that had just landed in the
    // queue and not yet been read by the SDK's input generator — the plain stop() this
    // used to call closes the queue and aborts immediately, discarding whatever's still
    // buffered. --resume on the respawned process only recovers messages that were
    // actually handed to the model, so it was lost for good with nothing logged.
    // drainAndStop() must wait for the buffered item to actually be picked up first.
    const received: string[] = [];
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const queryFn = vi.fn((args: any) => {
      const prompt = args.prompt as AsyncIterable<any>;
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
        // Don't read from `prompt` yet — simulates the model still being mid-turn on
        // something else while a new message sits buffered, unconsumed, in the queue.
        await gate;
        for await (const msg of prompt) {
          const content = msg.message?.content ?? msg.text;
          received.push(typeof content === 'string' ? content : JSON.stringify(content));
          yield { type: 'result', subtype: 'success', session_id: 'sess-1', result: 'ok' };
        }
      })();
    });

    const s = new ClaudeSession(queryFn as any, {}, () => {});
    s.start('first');
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    // At this point 'first' is sitting buffered in the queue — the fake generator
    // has yielded its init message but is now blocked on `gate`, so nothing has
    // iterated the queue yet.
    const stopped = s.drainAndStop(500);

    // Give the drain loop a couple of ticks so this genuinely exercises the wait
    // rather than racing past it before the first poll.
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toEqual([]); // not consumed yet — still correctly waiting

    releaseGate();
    await stopped;

    expect(received).toContain('first');
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

  it('watchdog: reconnects when a connection produces no stream activity at all (hung, not draining)', async () => {
    // Simulates the actual observed bug (785ca79's logging showed zero
    // "session stream drained" lines for either real hang): the connection
    // never drains, never errors, never yields a first message — it just
    // sits forever inside the equivalent of `for await`. Nothing before this
    // change could ever notice or recover from that.
    const received: string[] = [];
    let calls = 0;
    const queryFn = vi.fn((args: any) => {
      calls++;
      const attemptNo = calls;
      const prompt = args.prompt as AsyncIterable<any>;
      if (attemptNo === 1) {
        // First connection: total silence. Never yields, never resolves.
        return (async function* () {
          await new Promise<void>(() => {}); // never settles
          yield undefined as never; // unreachable; keeps TS happy about the generator's yield type
        })();
      }
      // Second connection (post-watchdog reconnect): behaves normally.
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
        for await (const msg of prompt) {
          const content = msg.message?.content ?? msg.text;
          received.push(typeof content === 'string' ? content : JSON.stringify(content));
          yield { type: 'result', subtype: 'success', session_id: 'sess-1', result: 'ok' };
        }
      })();
    });

    // Resolves instantly exactly ONCE (to trigger the reconnect out of the
    // hung first connection), then parks forever. An unconditionally-instant
    // watchdogWait would keep firing even once the SECOND connection is
    // healthy and correctly idle waiting for more queue input (nothing else
    // gets pushed in this test) — that's not a hang, but with idleMs
    // irrelevant and watchdogWait always resolving immediately, the
    // watchdog can't tell the difference and would abort+reconnect forever,
    // spinning as fast as the microtask queue allows until the process
    // OOMs. Caught by actually running this suite, not by reasoning about
    // the code by hand.
    let watchdogTicks = 0;
    const watchdogWait = () => {
      watchdogTicks++;
      if (watchdogTicks > 1) return new Promise<void>(() => {}); // stop spinning after the one legitimate hang
      return Promise.resolve();
    };

    const watchdogRetries: { idleMs: number; connectCount: number }[] = [];
    const s = new ClaudeSession(
      queryFn as any,
      {
        // Test seam SEPARATE from `wait` (retry backoff) specifically so
        // this can't be confused with, or accidentally satisfied/broken by,
        // the usage-limit tests' `wait` stub. No real sleep involved.
        watchdogWait,
        watchdogIdleMs: 1, // irrelevant value; the stub above ignores it
        watchdogGraceWait: () => Promise.resolve(), // not under test here — skip the real post-abort delay
      },
      () => {}, () => {}, () => {}, () => {},
      (info) => watchdogRetries.push(info),
    );

    s.start('first');

    // The watchdog should fire on the first (hung) connection and reconnect.
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(watchdogRetries.length).toBe(1));
    expect(watchdogRetries[0].connectCount).toBe(1);

    // The second, healthy connection actually carries the conversation.
    await vi.waitFor(() => expect(received).toContain('first'));

    s.stop();
  });

  it('watchdog: waits for the old connection to die before reconnecting', async () => {
    // Aborting only sends SIGTERM; the SDK gives the process up to 5s before
    // SIGKILL. Reconnecting in the same tick would run the dying process and
    // the new one side by side, competing for the same resources — this test
    // asserts the reconnect is gated on an explicit grace wait first.
    const queryFn = vi.fn((args: any) => {
      const prompt = args.prompt as AsyncIterable<any>;
      if (queryFn.mock.calls.length === 1) {
        return (async function* () { await new Promise<void>(() => {}); yield undefined as never; })();
      }
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
        for await (const _msg of prompt) { yield { type: 'result', subtype: 'success', session_id: 'sess-1', result: 'ok' }; }
      })();
    });

    let watchdogTicks = 0;
    const watchdogWait = () => {
      watchdogTicks++;
      if (watchdogTicks > 1) return new Promise<void>(() => {});
      return Promise.resolve();
    };

    let resolveGrace!: () => void;
    const gate = new Promise<void>((r) => (resolveGrace = r));
    const graceCalls: number[] = [];
    const watchdogGraceWait = (ms: number) => { graceCalls.push(ms); return gate; };

    const s = new ClaudeSession(
      queryFn as any,
      { watchdogWait, watchdogIdleMs: 1, watchdogGraceWait },
      () => {}, () => {}, () => {}, () => {},
      () => {},
    );
    s.start('first');

    await vi.waitFor(() => expect(graceCalls.length).toBe(1));
    // The grace wait hasn't resolved yet — reconnecting must not have happened.
    expect(queryFn).toHaveBeenCalledTimes(1);

    resolveGrace();
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));

    s.stop();
  });

  it('watchdog: jitters the idle timeout above the configured base', async () => {
    const capturedMs: number[] = [];
    const watchdogWait = (ms: number) => { capturedMs.push(ms); return new Promise<void>(() => {}); };
    const queryFn = vi.fn((_args: any) => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      await new Promise<void>(() => {});
      yield undefined as never;
    })());

    const s = new ClaudeSession(
      queryFn as any,
      { watchdogWait, watchdogIdleMs: 1000, random: () => 1 }, // max draw -> +20%
      () => {}, () => {}, () => {}, () => {}, () => {},
    );
    s.start('first');

    await vi.waitFor(() => expect(capturedMs.length).toBeGreaterThan(0));
    expect(capturedMs[0]).toBe(1200);

    s.stop();
  });

  it('watchdog: jitters the idle timeout below the configured base with a different draw', async () => {
    const capturedMs: number[] = [];
    const watchdogWait = (ms: number) => { capturedMs.push(ms); return new Promise<void>(() => {}); };
    const queryFn = vi.fn((_args: any) => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      await new Promise<void>(() => {});
      yield undefined as never;
    })());

    const s = new ClaudeSession(
      queryFn as any,
      { watchdogWait, watchdogIdleMs: 1000, random: () => 0 }, // min draw -> -20%
      () => {}, () => {}, () => {}, () => {}, () => {},
    );
    s.start('first');

    await vi.waitFor(() => expect(capturedMs.length).toBeGreaterThan(0));
    expect(capturedMs[0]).toBe(800);

    s.stop();
  });

  it('watchdog: switches to the much longer waiting threshold once a turn ends in plain text with no outstanding tool call', async () => {
    // A worker that answers in plain text (not via ask_user, not via finish) and is
    // simply waiting for the operator's reply is not hung — treat post-turn silence
    // with a much longer allowance than mid-turn silence.
    const capturedMs: number[] = [];
    const watchdogWait = (ms: number) => { capturedMs.push(ms); return new Promise<void>(() => {}); };
    const queryFn = vi.fn((_args: any) => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      // Real shape (confirmed against the live API): the assistant message's own
      // stop_reason is always null — the turn only concludes on the separate,
      // later `result` message, which carries the real stop_reason.
      yield {
        type: 'assistant',
        session_id: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Here is my complete answer — what do you think?' }], stop_reason: null },
      };
      yield { type: 'result', subtype: 'success', session_id: 'sess-1', stop_reason: 'end_turn', result: 'ok' };
      await new Promise<void>(() => {}); // then silence, waiting on the operator
      yield undefined as never;
    })());

    const s = new ClaudeSession(
      queryFn as any,
      { watchdogWait, watchdogIdleMs: 1000, watchdogWaitingIdleMs: 100_000, random: () => 0.5 }, // random=0.5 -> no jitter offset
      () => {}, () => {}, () => {}, () => {}, () => {},
    );
    s.start('first');

    await vi.waitFor(() => expect(capturedMs.length).toBe(4));
    // Reads before the result message use the short (active-work) threshold; the
    // read armed right after it uses the long (waiting-on-operator) threshold.
    expect(capturedMs).toEqual([1000, 1000, 1000, 100_000]);

    s.stop();
  });

  it('calls onSilentTurnEnd with the final text when a turn ends with no tool call at all', async () => {
    // WORKER_SYSTEM_PROMPT says tools are the only way to communicate, but nothing
    // enforces that — a model can end a turn with pure text and no tool_use. That
    // reply is otherwise completely invisible (no send_update/ask_user/finish ever
    // ran to post it). onSilentTurnEnd is the fallback that surfaces it anyway.
    const queryFn = vi.fn((_args: any) => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      yield {
        type: 'assistant',
        session_id: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Looks done to me.' }], stop_reason: null },
      };
      yield { type: 'result', subtype: 'success', session_id: 'sess-1', stop_reason: 'end_turn', result: 'Looks done to me.' };
      await new Promise<void>(() => {});
      yield undefined as never;
    })());

    const silent: string[] = [];
    const s = new ClaudeSession(
      queryFn as any,
      {},
      () => {}, () => {}, () => {}, () => {}, () => {}, () => {},
      (text) => silent.push(text),
    );
    s.start('first');

    await vi.waitFor(() => expect(silent).toEqual(['Looks done to me.']));

    s.stop();
  });

  it('does not call onSilentTurnEnd when the turn used a tool before ending', async () => {
    const queryFn = vi.fn((_args: any) => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      yield {
        type: 'assistant',
        session_id: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__worker__send_update', input: {} }], stop_reason: null },
      };
      yield { type: 'user', session_id: 'sess-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] } };
      yield {
        type: 'assistant',
        session_id: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Posted the update.' }], stop_reason: null },
      };
      yield { type: 'result', subtype: 'success', session_id: 'sess-1', stop_reason: 'end_turn', result: 'Posted the update.' };
      await new Promise<void>(() => {});
      yield undefined as never;
    })());

    const silent: string[] = [];
    const s = new ClaudeSession(
      queryFn as any,
      {},
      () => {}, () => {}, () => {}, () => {}, () => {}, () => {},
      (text) => silent.push(text),
    );
    s.start('first');

    await vi.waitFor(() => expect(queryFn).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(silent).toEqual([]);

    s.stop();
  });

  it('DOES call onSilentTurnEnd when the only tool used was not a communication tool', async () => {
    // Real incident (2026-09-11): a worker used Bash to investigate (query a
    // database), then gave its actual answer as plain text with no
    // send_update/ask_user/finish call. "Any tool use counts" wrongly treated
    // the Bash call as "already communicated" — Bash/Read/Edit never reach
    // the operator, only the whitelisted communicationToolNames do — so the
    // real answer was silently dropped exactly like a no-tool-at-all turn.
    const queryFn = vi.fn((_args: any) => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      yield {
        type: 'assistant',
        session_id: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'echo hi' } }], stop_reason: null },
      };
      yield { type: 'user', session_id: 'sess-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'hi' }] } };
      yield {
        type: 'assistant',
        session_id: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'w-d22cd448 is the agent working on that branch.' }], stop_reason: null },
      };
      yield { type: 'result', subtype: 'success', session_id: 'sess-1', stop_reason: 'end_turn', result: 'w-d22cd448 is the agent working on that branch.' };
      await new Promise<void>(() => {});
      yield undefined as never;
    })());

    const silent: string[] = [];
    const s = new ClaudeSession(
      queryFn as any,
      { communicationToolNames: ['mcp__worker__ask_user', 'mcp__worker__send_update', 'mcp__worker__finish'] },
      () => {}, () => {}, () => {}, () => {}, () => {}, () => {},
      (text) => silent.push(text),
    );
    s.start('first');

    await vi.waitFor(() => expect(silent).toEqual(['w-d22cd448 is the agent working on that branch.']));

    s.stop();
  });

  it('does not call onSilentTurnEnd when a whitelisted communication tool was used', async () => {
    const queryFn = vi.fn((_args: any) => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      yield {
        type: 'assistant',
        session_id: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__worker__send_update', input: {} }], stop_reason: null },
      };
      yield { type: 'user', session_id: 'sess-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] } };
      yield {
        type: 'assistant',
        session_id: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Posted the update.' }], stop_reason: null },
      };
      yield { type: 'result', subtype: 'success', session_id: 'sess-1', stop_reason: 'end_turn', result: 'Posted the update.' };
      await new Promise<void>(() => {});
      yield undefined as never;
    })());

    const silent: string[] = [];
    const s = new ClaudeSession(
      queryFn as any,
      { communicationToolNames: ['mcp__worker__ask_user', 'mcp__worker__send_update', 'mcp__worker__finish'] },
      () => {}, () => {}, () => {}, () => {}, () => {}, () => {},
      (text) => silent.push(text),
    );
    s.start('first');

    await vi.waitFor(() => expect(queryFn).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(silent).toEqual([]);

    s.stop();
  });

  it('does not re-fire onSilentTurnEnd for the same turn after a watchdog reconnect replays it', async () => {
    // A resumed connection can re-surface the prior turn's already-ended result
    // (see the 'session stream drained' comment on resume replay). Without a
    // cross-connection guard, a silent-text turn that sits unanswered long
    // enough to hit the waiting-threshold watchdog would get reposted to
    // Mattermost every time it reconnects.
    let calls = 0;
    const queryFn = vi.fn((_args: any) => {
      calls++;
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
        yield {
          type: 'assistant',
          session_id: 'sess-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'still waiting' }], stop_reason: null },
        };
        yield { type: 'result', subtype: 'success', session_id: 'sess-1', stop_reason: 'end_turn', result: 'still waiting' };
        await new Promise<void>(() => {});
        yield undefined as never;
      })();
    });

    const silent: string[] = [];
    // Real (tiny) macrotask delays, not Promise.resolve() — a zero-delay stub
    // here spins the reconnect loop as fast as the microtask queue allows.
    const tick = () => new Promise<void>((r) => setTimeout(r, 1));
    const s = new ClaudeSession(
      queryFn as any,
      // triggerProcessRestart stubbed: this loop reconnects fast enough on
      // real (if tiny) timers that it could otherwise reach the real
      // maxConsecutiveWaitingReconnects default before the test's own
      // calls>=3 check and stop() take effect, sending a real SIGHUP to the
      // test runner itself (no handler installed here — it would just die).
      { watchdogWait: tick, watchdogGraceWait: tick, watchdogIdleMs: 1, watchdogWaitingIdleMs: 1, triggerProcessRestart: () => {} },
      () => {}, () => {}, () => {}, () => {}, () => {}, () => {},
      (text) => silent.push(text),
    );
    s.start('first');

    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(3)); // watchdog reconnected at least twice
    s.stop();
    expect(silent).toEqual(['still waiting']); // fired once, not once per connection
  });

  it('watchdog: carries the long waiting threshold across a reconnect instead of resetting to vigilant', async () => {
    // Real incident: once a worker legitimately finishes a turn and is waiting on
    // the operator, resetting to the short "vigilant" threshold on every reconnect
    // defeats the whole point of the long waiting threshold — the very first
    // waiting-threshold reconnect (itself routine: nothing queued to send, so it
    // gets zero messages) immediately falls back to a ~20min cadence, silently
    // reconnecting over and over with nothing to say, racing toward
    // maxConsecutiveSilentReconnects and forcing an unwanted full process restart
    // roughly every hour — even though nothing was ever actually hung.
    const capturedMs: number[] = [];
    let calls = 0;
    let longTimeoutsForced = 0;
    const watchdogWait = (ms: number) => {
      capturedMs.push(ms);
      // The long threshold "times out" exactly once, forcing exactly one
      // reconnect — the short (vigilant) ticks and every wait after that
      // never resolve, so real message delivery (or the test's own stop())
      // decides what happens next instead of an unbounded reconnect loop.
      if (ms === 100_000 && longTimeoutsForced === 0) { longTimeoutsForced++; return Promise.resolve(); }
      return new Promise<void>(() => {});
    };
    const watchdogGraceWait = () => new Promise<void>((r) => setTimeout(r, 1));
    const queryFn = vi.fn((_args: any) => {
      calls++;
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
        if (calls === 1) {
          yield {
            type: 'assistant',
            session_id: 'sess-1',
            message: { role: 'assistant', content: [{ type: 'text', text: 'complete answer' }], stop_reason: null },
          };
          yield { type: 'result', subtype: 'success', session_id: 'sess-1', stop_reason: 'end_turn', result: 'ok' };
        }
        // Reconnects after the first: nothing queued (operator hasn't replied) — silence.
        await new Promise<void>(() => {});
        yield undefined as never;
      })();
    });

    const s = new ClaudeSession(
      queryFn as any,
      { watchdogWait, watchdogGraceWait, watchdogIdleMs: 1000, watchdogWaitingIdleMs: 100_000, random: () => 0.5 },
      () => {}, () => {}, () => {}, () => {}, () => {},
    );
    s.start('first');

    // First connection: two vigilant ticks, then the result ends the turn and the
    // third tick already goes long (matches the existing "switches to..." test).
    // Once THAT long wait "fires" and we reconnect, the fresh connection's first
    // tick must also be long — not reset back to 1000.
    await vi.waitFor(() => expect(capturedMs.length).toBeGreaterThanOrEqual(5));
    s.stop();

    expect(capturedMs.slice(0, 3)).toEqual([1000, 1000, 1000]); // pre-result reads on connection 1
    expect(capturedMs[3]).toBe(100_000); // post-result, first connection — times out, forces reconnect
    expect(capturedMs[4]).toBe(100_000); // post-reconnect, second connection — carried forward, not reset to 1000
  });

  it('does not call onSilentTurnEnd when a tool was used earlier in the turn, even after a mid-turn reconnect', async () => {
    // turnCommunicated now also survives reconnects (same session-lifetime scope as
    // turnEnded). A turn that uses a tool, then hangs and reconnects mid-turn
    // (genuinely — turnEnded stays false, the short threshold applies), then ends
    // via a result with no further tool use on the fresh connection, must still be
    // recognized as tool-driven — not misreported as a silent text-only reply.
    const capturedMs: number[] = [];
    let calls = 0;
    let waitInvocations = 0;
    const watchdogWait = (ms: number) => {
      capturedMs.push(ms);
      waitInvocations++;
      // Only the 3rd wait (system/init consumed, tool_use consumed, now genuinely
      // hung with nothing more coming on this connection) times out — every other
      // tick never resolves, so real message delivery always wins that race
      // instead of racing two same-tick promises.
      return waitInvocations === 3 ? Promise.resolve() : new Promise<void>(() => {});
    };
    const watchdogGraceWait = () => new Promise<void>((r) => setTimeout(r, 1));
    const queryFn = vi.fn((_args: any) => {
      calls++;
      return (async function* () {
        if (calls === 1) {
          yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
          yield {
            type: 'assistant',
            session_id: 'sess-1',
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__worker__send_update', input: {} }], stop_reason: null },
          };
          // Hangs here — connection dies mid-turn, no result yet.
          await new Promise<void>(() => {});
        } else {
          yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
          yield {
            type: 'assistant',
            session_id: 'sess-1',
            message: { role: 'assistant', content: [{ type: 'text', text: 'Posted the update.' }], stop_reason: null },
          };
          yield { type: 'result', subtype: 'success', session_id: 'sess-1', stop_reason: 'end_turn', result: 'Posted the update.' };
          await new Promise<void>(() => {});
        }
        yield undefined as never;
      })();
    });

    const silent: string[] = [];
    const s = new ClaudeSession(
      queryFn as any,
      { watchdogWait, watchdogGraceWait, watchdogIdleMs: 1000, watchdogWaitingIdleMs: 100_000 },
      () => {}, () => {}, () => {}, () => {}, () => {}, () => {},
      (text) => silent.push(text),
    );
    s.start('first');

    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
    await new Promise((r) => setTimeout(r, 10));
    s.stop();

    expect(silent).toEqual([]); // tool use earlier in the turn correctly suppresses the fallback
  });

  it('watchdog: push() during a long waiting-threshold wait re-arms with the short threshold instead of waiting it out', async () => {
    // If the connection is actually dead, waiting out the full ~3h waiting
    // threshold after the operator has already replied would be far worse
    // than the original ~20min detection time. An operator reply is a signal
    // that ambient patience should reset back to vigilant.
    const capturedMs: number[] = [];
    const watchdogWait = (ms: number) => { capturedMs.push(ms); return new Promise<void>(() => {}); };
    const queryFn = vi.fn((_args: any) => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      yield {
        type: 'assistant',
        session_id: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'complete answer' }], stop_reason: null },
      };
      yield { type: 'result', subtype: 'success', session_id: 'sess-1', stop_reason: 'end_turn', result: 'ok' };
      await new Promise<void>(() => {}); // dead from here — never reads input, never produces more output
      yield undefined as never;
    })());

    const s = new ClaudeSession(
      queryFn as any,
      { watchdogWait, watchdogIdleMs: 1000, watchdogWaitingIdleMs: 100_000, random: () => 0.5 },
      () => {}, () => {}, () => {}, () => {}, () => {},
    );
    s.start('first');

    await vi.waitFor(() => expect(capturedMs).toEqual([1000, 1000, 1000, 100_000]));

    s.push('operator follow-up'); // the connection is dead and will never see this, but patience should reset

    await vi.waitFor(() => expect(capturedMs.length).toBe(5));
    expect(capturedMs[4]).toBe(1000);

    s.stop();
  });

  it('watchdog: keeps the short threshold while a tool call is outstanding (mid-turn), even after seeing prior activity', async () => {
    const capturedMs: number[] = [];
    const watchdogWait = (ms: number) => { capturedMs.push(ms); return new Promise<void>(() => {}); };
    const queryFn = vi.fn((_args: any) => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      yield {
        type: 'assistant',
        session_id: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }], stop_reason: 'tool_use' },
      };
      await new Promise<void>(() => {}); // then silence, simulating a long-running tool
      yield undefined as never;
    })());

    const s = new ClaudeSession(
      queryFn as any,
      { watchdogWait, watchdogIdleMs: 1000, watchdogWaitingIdleMs: 100_000, random: () => 0.5 },
      () => {}, () => {}, () => {}, () => {}, () => {},
    );
    s.start('first');

    await vi.waitFor(() => expect(capturedMs.length).toBe(3));
    expect(capturedMs).toEqual([1000, 1000, 1000]); // stays short — a tool call is in flight, not waiting on the operator

    s.stop();
  });

  it('watchdog: does not fire while an ask_user tool call is outstanding, however long it takes', async () => {
    // ask_user waits are legitimately unbounded (default 24h,
    // askUserTimeoutMs) — a real example in data/supervisor.log ran ~9h21m
    // before the operator replied. The watchdog must never "recover" that.
    let toolUseYielded = false;
    const queryFn = vi.fn((args: any) => {
      const prompt = args.prompt as AsyncIterable<any>;
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
        // Announce an ask_user tool_use, then go silent indefinitely — same
        // shape as a real ask_user call blocked on PendingQuestions.ask().
        yield {
          type: 'assistant',
          session_id: 'sess-1',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__worker__ask_user', input: {} }] },
        };
        toolUseYielded = true;
        await new Promise<void>(() => {}); // never resolves — the "human hasn't replied yet" state
        for await (const _ of prompt) { /* unreachable */ }
      })();
    });

    // The watchdog timer polls a real (short, bounded-rate) 5ms interval
    // for an `armed` flag rather than using instant/never-resolving
    // Promises directly. This matters for a subtle reason found by actually
    // running this test: `watchdogWait()` is called ONCE per pending read
    // and its returned promise's resolution is fixed at creation time —
    // flipping a boolean flag *after* an already-returned "never resolves"
    // promise was created has NO effect on that promise, since nothing
    // reevaluates it. Since this test's read-after-tool_use is a single
    // long-lived pending read (the generator blocks forever right after
    // yielding tool_use), there is exactly one watchdogWait() call
    // outstanding at the moment `armed` flips — a boolean-gated
    // "return new Promise(()=>{}) vs Promise.resolve()" design can only
    // ever see the state as of ITS OWN creation instant, so that one call
    // hangs forever regardless of when `armed` later becomes true. Real
    // setTimeout-based polling doesn't have this problem: each 5ms tick
    // freshly re-checks `armed`, so a call created before arming still
    // resolves promptly once arming happens. It's also strictly immune to
    // the microtask-starvation OOM this suite caught earlier (bounded-rate
    // real timers, never a tight synchronous/microtask loop).
    let armed = false;
    let ticks = 0;
    const TICK_BUDGET = 5;
    const watchdogWait = () => new Promise<void>((resolve) => {
      const poll = () => {
        if (!armed) { setTimeout(poll, 5); return; }
        ticks++;
        if (ticks > TICK_BUDGET) return; // stop resolving; test is done sampling
        resolve();
      };
      poll();
    });

    const watchdogRetries: unknown[] = [];
    const s = new ClaudeSession(
      queryFn as any,
      { watchdogWait, watchdogIdleMs: 1 },
      () => {}, () => {}, () => {}, () => {},
      (info) => watchdogRetries.push(info),
    );

    s.start('first');
    await vi.waitFor(() => expect(toolUseYielded).toBe(true));
    // Real settling time so runLoop actually reads+tracks the already-
    // yielded messages before the watchdog timer is allowed to resolve.
    await new Promise((r) => setTimeout(r, 20));
    armed = true;

    // Let the bounded number of suppressed ticks actually happen.
    await vi.waitFor(() => expect(ticks).toBeGreaterThan(TICK_BUDGET));

    expect(watchdogRetries).toEqual([]);
    expect(queryFn).toHaveBeenCalledTimes(1);

    s.stop();
  });

  it('watchdog: after N consecutive silent reconnects, restarts the whole process instead of reconnecting again', async () => {
    // A session that never produces a single message on ANY connection —
    // reconnecting within-process clearly isn't helping. A real overnight
    // incident saw this exact pattern fail 37 consecutive times over 13
    // hours with no recovery; only a full process restart ever works.
    const queryFn = vi.fn((_args: any) => (async function* () {
      await new Promise<void>(() => {}); // never yields anything at all
      yield undefined as never;
    })());

    const watchdogWait = () => Promise.resolve();
    const watchdogGraceWait = () => Promise.resolve();
    const restarts: void[] = [];
    const triggerProcessRestart = () => { restarts.push(undefined); };

    const s = new ClaudeSession(
      queryFn as any,
      { watchdogWait, watchdogGraceWait, watchdogIdleMs: 1, maxConsecutiveSilentReconnects: 2, triggerProcessRestart },
      () => {}, () => {}, () => {}, () => {}, () => {},
    );
    s.start('first');

    await vi.waitFor(() => expect(restarts.length).toBe(1));
    // Exactly 2 connection attempts — the 2nd restarts the process instead of a 3rd reconnect.
    expect(queryFn).toHaveBeenCalledTimes(2);

    s.stop();
  });

  it('watchdog: does not notify or escalate for routine waiting-threshold reconnects — only for genuine mid-turn hangs', async () => {
    // Real incident (2026-09-10): once a turn legitimately ends and nothing is
    // queued, EVERY waiting-threshold reconnect gets zero messages by design (a
    // resumed connection with nothing to send emits nothing at all) — that's
    // not a hang, it's the expected shape of "correctly idle". Before this fix,
    // every one of these routine reconnects still posted a "seemed stuck"
    // notification and counted toward maxConsecutiveSilentReconnects, eventually
    // force-restarting the whole process — pure noise, repeating every few
    // hours with nothing ever actually wrong.
    let calls = 0;
    const queryFn = vi.fn((_args: any) => {
      calls++;
      return (async function* () {
        if (calls === 1) {
          yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
          yield {
            type: 'assistant',
            session_id: 'sess-1',
            message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: null },
          };
          yield { type: 'result', subtype: 'success', session_id: 'sess-1', stop_reason: 'end_turn', result: 'done' };
        }
        await new Promise<void>(() => {});
        yield undefined as never;
      })();
    });

    let waitInvocations = 0;
    const watchdogWait = () => {
      waitInvocations++;
      // Connection 1's 3 real messages (system/init, assistant, result) must
      // win their races — only once the turn has genuinely ended and gone
      // silent does the timer start actually firing.
      if (waitInvocations <= 3) return new Promise<void>(() => {});
      return Promise.resolve();
    };
    const watchdogGraceWait = () => new Promise<void>((r) => setTimeout(r, 1));
    const retries: unknown[] = [];
    const giveUps: unknown[] = [];
    const restarts: void[] = [];
    const triggerProcessRestart = () => { restarts.push(undefined); };

    const s = new ClaudeSession(
      queryFn as any,
      // maxConsecutiveWaitingReconnects deliberately left huge: this test's
      // own bound (calls>=5) is a lower watermark, not an exact count — real
      // (if tiny) timers mean a few extra reconnects can slip in before
      // stop() takes effect, and the point here is proving NONE of them ever
      // escalate, not pinning an exact iteration count.
      { watchdogWait, watchdogGraceWait, watchdogIdleMs: 1, watchdogWaitingIdleMs: 1, maxConsecutiveSilentReconnects: 2, maxConsecutiveWaitingReconnects: 100_000, triggerProcessRestart },
      () => {}, () => {}, () => {}, () => {},
      (info) => retries.push(info),
      (info) => giveUps.push(info),
    );
    s.start('first');

    // Well past maxConsecutiveSilentReconnects (2) — if these wrongly counted,
    // restart would already have fired by now.
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(5));
    s.stop();

    expect(restarts).toEqual([]);
    expect(giveUps).toEqual([]);
    expect(retries).toEqual([]); // no "seemed stuck" notification — this is routine, not a hang
  });

  it('watchdog: after enough consecutive waiting-threshold reconnects with no operator engagement, restarts the process anyway', async () => {
    // The quiet branch above has its OWN, much longer ceiling — without one,
    // a connection that's genuinely, permanently dead while turnEnded=true
    // would reconnect forever with zero backstop (the exact unbounded-silence
    // failure mode maxConsecutiveSilentReconnects exists to catch, just in
    // this state). Once that ceiling IS reached, it should notify and
    // restart just like the mid-turn-hang path does — reaching it is no
    // longer "routine".
    let calls = 0;
    const queryFn = vi.fn((_args: any) => {
      calls++;
      return (async function* () {
        if (calls === 1) {
          yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
          yield {
            type: 'assistant',
            session_id: 'sess-1',
            message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: null },
          };
          yield { type: 'result', subtype: 'success', session_id: 'sess-1', stop_reason: 'end_turn', result: 'done' };
        }
        await new Promise<void>(() => {});
        yield undefined as never;
      })();
    });

    let waitInvocations = 0;
    const watchdogWait = () => {
      waitInvocations++;
      if (waitInvocations <= 3) return new Promise<void>(() => {});
      return Promise.resolve();
    };
    const watchdogGraceWait = () => Promise.resolve();
    const restarts: void[] = [];
    const giveUps: unknown[] = [];
    const triggerProcessRestart = () => { restarts.push(undefined); };

    const s = new ClaudeSession(
      queryFn as any,
      { watchdogWait, watchdogGraceWait, watchdogIdleMs: 1, watchdogWaitingIdleMs: 1, maxConsecutiveWaitingReconnects: 3, triggerProcessRestart },
      () => {}, () => {}, () => {}, () => {}, () => {},
      (info) => giveUps.push(info),
    );
    s.start('first');

    await vi.waitFor(() => expect(restarts.length).toBe(1));
    // Connection 1's own post-result timeout is waiting-reconnect #1; connections
    // 2 and 3 are #2 and #3 — the 3rd (maxConsecutiveWaitingReconnects) restarts
    // instead of reconnecting a 4th time.
    expect(queryFn).toHaveBeenCalledTimes(3);
    expect(giveUps).toEqual([{ connectCount: 3, consecutiveSilentReconnects: 3 }]);

    s.stop();
  });

  it('watchdog: resets the silent-reconnect counter once a connection gets any real message', async () => {
    // Connection 2 gets a message before going silent; connections 1, 3, 4
    // get nothing. With a threshold of 2, this must take 4 connections (not
    // 2) to restart, since connection 2's message resets the count to 0.
    let calls = 0;
    const queryFn = vi.fn((_args: any) => {
      calls++;
      const thisCall = calls;
      return (async function* () {
        if (thisCall === 2) yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
        await new Promise<void>(() => {});
        yield undefined as never;
      })();
    });

    // The 2nd armIdle() call is connection 2's FIRST read — it must hang so
    // the immediately-yielded message wins that race instead of the (also
    // instant) idle timer; every other call resolves (times out) right away.
    let armIdleCalls = 0;
    const watchdogWait = () => {
      armIdleCalls++;
      if (armIdleCalls === 2) return new Promise<void>(() => {});
      return Promise.resolve();
    };
    const watchdogGraceWait = () => Promise.resolve();
    const restarts: void[] = [];
    const triggerProcessRestart = () => { restarts.push(undefined); };

    const s = new ClaudeSession(
      queryFn as any,
      { watchdogWait, watchdogGraceWait, watchdogIdleMs: 1, maxConsecutiveSilentReconnects: 2, triggerProcessRestart },
      () => {}, () => {}, () => {}, () => {}, () => {},
    );
    s.start('first');

    await vi.waitFor(() => expect(restarts.length).toBe(1));
    expect(queryFn).toHaveBeenCalledTimes(4);

    s.stop();
  });

  it('watchdog: does not restart the process if stop() raced in right as the threshold fired', async () => {
    // stop() can flip `running` false in the same tick the idle timer wins
    // the race (simulated here by calling it from inside the watchdogWait
    // stub itself). A session that's merely being torn down normally must
    // not drag the whole process down with it.
    const queryFn = vi.fn((_args: any) => (async function* () {
      await new Promise<void>(() => {});
      yield undefined as never;
    })());

    const restarts: void[] = [];
    const triggerProcessRestart = () => { restarts.push(undefined); };
    let s!: ClaudeSession;
    const watchdogWait = () => new Promise<void>((resolve) => {
      s.stop(); // races in right as this connection's idle timer is about to fire
      resolve();
    });

    s = new ClaudeSession(
      queryFn as any,
      { watchdogWait, watchdogIdleMs: 1, maxConsecutiveSilentReconnects: 1, triggerProcessRestart },
      () => {}, () => {}, () => {}, () => {}, () => {},
    );
    s.start('first');

    await new Promise((r) => setTimeout(r, 20));
    expect(restarts).toEqual([]);
  });

  it('watchdog: calls onGiveUp with the failure count right before restarting the process', async () => {
    const queryFn = vi.fn((_args: any) => (async function* () {
      await new Promise<void>(() => {});
      yield undefined as never;
    })());

    const watchdogWait = () => Promise.resolve();
    const watchdogGraceWait = () => Promise.resolve();
    const restarts: void[] = [];
    const giveUps: { connectCount: number; consecutiveSilentReconnects: number }[] = [];
    const triggerProcessRestart = () => { restarts.push(undefined); };

    const s = new ClaudeSession(
      queryFn as any,
      { watchdogWait, watchdogGraceWait, watchdogIdleMs: 1, maxConsecutiveSilentReconnects: 2, triggerProcessRestart },
      () => {}, () => {}, () => {}, () => {}, () => {},
      (info) => giveUps.push(info),
    );
    s.start('first');

    await vi.waitFor(() => expect(restarts.length).toBe(1));
    expect(giveUps).toEqual([{ connectCount: 2, consecutiveSilentReconnects: 2 }]);

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
