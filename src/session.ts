import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { parseUsageLimit } from './usageLimit.js';
import { log } from './log.js';
import { processDiagnostics } from './diagnostics.js';

export type QueryFn = typeof import('@anthropic-ai/claude-agent-sdk').query;

// How long a connection may go without producing ANY stream message before
// we treat it as hung and reconnect. Calibrated from data/supervisor.log:
//  - claim_dev's own blocking wait is hard-bounded by devClaimWaitTimeoutMs
//    (config.ts, default 900_000ms = 15 min); the longest real instance
//    found in the log was ~7min (18:38:07 -> 18:45:12, worker w-817ef448).
//    20 minutes clears that with margin.
//  - The two real "silent worker" incidents this is meant to catch went
//    unnoticed for ~17h and ~7h respectively (workers w-5d60c88d,
//    w-db12fb73) and were only ever recovered by a full process restart
//    (Bridge.start()'s "resumed worker" reconciliation) — nothing today
//    detects or recovers from this automatically.
// CONFIRMED (empirically, against the real API — see git history for the
// throwaway repro): while a turn is actively in progress, the CLI reliably
// produces activity well within this window regardless of what it's doing —
// tool_progress/heartbeat messages every ~30s during a long Bash or SDK-MCP
// tool call, and thinking_tokens messages every ~1-2s during extended
// thinking with no tool call at all. So persistent silence while a turn is
// still open (see turnEnded below) really does mean stuck. This threshold
// does NOT apply once a turn has cleanly ended — see
// DEFAULT_WATCHDOG_WAITING_IDLE_MS.
export const DEFAULT_WATCHDOG_IDLE_MS = 20 * 60_000; // 20 minutes

// How long to wait once a turn has ENDED (a result message with no
// outstanding tool_use since — see nextTurnEnded below) with nothing
// pushed since. This is indistinguishable, from our side, from a
// worker correctly waiting on the operator to read and reply — a real,
// common state (a human often takes well over 20 minutes to notice a
// message), not a hang. A genuinely dead connection in this state is rare
// enough that a long backstop is fine; the original two "silent worker"
// incidents this watchdog exists to catch went unnoticed for ~17h and ~7h
// before this existed at all, so several hours of patience here is still a
// large improvement over no recovery at all.
export const DEFAULT_WATCHDOG_WAITING_IDLE_MS = 3 * 60 * 60_000; // 3 hours

// A watchdog-fired abort() only sends SIGTERM; the SDK gives the process up
// to 5s before escalating to SIGKILL (see sdk.mjs). Reconnecting immediately
// would run the dying process and its replacement side by side, competing
// for the same CPU/memory right as the new connection is doing its most
// expensive work (replaying a large cached session) — so the watchdog waits
// this long past abort() before reconnecting, comfortably past that 5s.
export const DEFAULT_WATCHDOG_KILL_GRACE_MS = 5_500;

// A real overnight incident: the same session failed to get even a single
// stream message on 37 CONSECUTIVE reconnects over 13 hours, never once
// recovering, with nothing noticing. Every within-process reconnect shares
// whatever made the first one fail (see graceWait's SIGTERM->SIGKILL
// reasoning for one known contributor) — but a full process restart has a
// 100% observed recovery rate every time it's been tried. Past this many
// consecutive reconnects that got zero messages, stop retrying in-process
// and restart the whole process instead — see triggerProcessRestart().
export const DEFAULT_WATCHDOG_MAX_CONSECUTIVE_SILENT_RECONNECTS = 3;

// How much a connection's idle timeout is randomized around its base value
// (watchdogIdleMs/DEFAULT_WATCHDOG_IDLE_MS), e.g. 0.2 = +/-20%. Several
// sessions that all last connected at the same moment (e.g. every worker
// resumed together after a process restart) would otherwise have their
// watchdog timers permanently synchronized, retrying in lockstep every
// cycle forever and repeatedly competing for the same resources. Jitter
// desynchronizes them over a few cycles instead.
const WATCHDOG_IDLE_JITTER_RATIO = 0.2;

// Tool names whose in-flight tool_use legitimately blocks far longer than
// DEFAULT_WATCHDOG_IDLE_MS on something outside the model/CLI's control (a
// human's reply) — the watchdog must not fire while one of these is
// outstanding, or it will "recover" a session that was never actually
// stuck, abort the tool call's underlying connection, and silently orphan
// the pending operator question (PendingQuestions.ask()'s promise lives in
// this process, keyed off a CLI subprocess the abort would kill; only
// Bridge.start()'s restart reconciliation knows how to detect and clear an
// orphaned question — a per-connection watchdog reconnect doesn't go
// through that path). claim_dev is deliberately NOT here: its wait is
// already hard-bounded by devClaimWaitTimeoutMs (15 min default), safely
// under DEFAULT_WATCHDOG_IDLE_MS.
const WATCHDOG_EXEMPT_TOOLS = new Set(['mcp__worker__ask_user']);

export interface SessionOptions {
  cwd?: string;
  systemPromptAppend?: string;
  model?: string;
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  disallowedTools?: string[];
  env?: Record<string, string>;
  resume?: string;
  hooks?: Record<string, unknown>;
  // Resilience tuning + injectables (tests override wait/now to avoid real sleeps).
  wait?: (ms: number) => Promise<void>;
  now?: () => Date;
  retryFloorMs?: number;   // never wait less than this on a limit
  retryBackoffCapMs?: number; // cap for exponential backoff when no reset time is known
  retryMaxMs?: number;     // absolute ceiling for any single wait (bounds a bad reset value)
  // Inactivity watchdog: reconnect if no stream message arrives for this
  // long while a turn is nominally in progress (see DEFAULT_WATCHDOG_IDLE_MS
  // for calibration). Exempts ask_user waits — see WATCHDOG_EXEMPT_TOOLS.
  watchdogIdleMs?: number;
  // Idle allowance once a turn has cleanly ended with nothing pushed since —
  // see DEFAULT_WATCHDOG_WAITING_IDLE_MS.
  watchdogWaitingIdleMs?: number;
  // Test seam for the watchdog timer, deliberately SEPARATE from `wait`
  // above: the usage-limit tests already stub `wait` to resolve instantly
  // to skip retry backoff sleeps, and reusing the same function for the
  // watchdog would make it fire spuriously mid-message-loop in those tests.
  watchdogWait?: (ms: number) => Promise<void>;
  // How long to wait after aborting a hung connection before reconnecting
  // (see DEFAULT_WATCHDOG_KILL_GRACE_MS). Test seam, separate from `wait`
  // and `watchdogWait` for the same reason those are separate from each other.
  watchdogKillGraceMs?: number;
  watchdogGraceWait?: (ms: number) => Promise<void>;
  // Test seam for the watchdog's idle-timeout jitter (see
  // WATCHDOG_IDLE_JITTER_RATIO). Defaults to Math.random.
  random?: () => number;
  // How many consecutive reconnects that got zero stream messages before
  // giving up on in-process recovery and restarting the whole process — see
  // DEFAULT_WATCHDOG_MAX_CONSECUTIVE_SILENT_RECONNECTS.
  maxConsecutiveSilentReconnects?: number;
  // Test seam: what to call instead of actually restarting the process.
  // Defaults to sending this process SIGHUP (installSelfReload's handler).
  triggerProcessRestart?: () => void;
}

// Minimal async queue: an async-iterable you can push to and close.
class MessageQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private resolvers: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;
  push(item: T): void {
    if (this.closed) return;
    const r = this.resolvers.shift();
    if (r) r({ value: item, done: false });
    else this.items.push(item);
  }
  close(): void {
    this.closed = true;
    let r; while ((r = this.resolvers.shift())) r({ value: undefined as any, done: true });
  }
  /** True when a freshly-created iterator would receive an item immediately (nothing is waiting to consume it yet). */
  get pending(): boolean { return this.items.length > 0; }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as any, done: true });
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

// Construct a minimal SDKUserMessage for a plain-text user turn.
// parent_tool_use_id is required by SDKUserMessage (null for top-level messages).
function userMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

export class ClaudeSession {
  private queue = new MessageQueue<SDKUserMessage>();
  private _sessionId?: string;
  private running = false;
  private stopped = false;
  private aborter = new AbortController();
  // Resolved (all of them, then cleared) whenever there's a reason for a
  // parked runLoop to wake up and re-check: a push() arrived, or stop() ran.
  private idleWaiters: (() => void)[] = [];
  constructor(
    private queryFn: QueryFn,
    private opts: SessionOptions,
    private onSessionId?: (id: string) => void,
    private onError?: (err: unknown) => void,
    private onPause?: (resetAt?: Date) => void,
    private onResume?: () => void,
    // Fired when the inactivity watchdog aborts a hung connection attempt
    // and reconnects — so the operator sees *why* a worker briefly went
    // quiet instead of it looking like silent self-healing (or, if it keeps
    // happening, a real unresolved problem). See DEFAULT_WATCHDOG_IDLE_MS.
    private onWatchdogRetry?: (info: { idleMs: number; connectCount: number }) => void,
    // Fired once, right before giving up on in-process recovery and
    // restarting the whole process — see maxConsecutiveSilentReconnects.
    // Distinct from onWatchdogRetry: this is the "it kept happening" case
    // that callback's own doc comment anticipates, not another quiet retry.
    private onGiveUp?: (info: { connectCount: number; consecutiveSilentReconnects: number }) => void,
  ) {}

  get sessionId(): string | undefined { return this._sessionId; }

  start(initialMessage: string): void {
    if (this.running) return;
    this.running = true;
    this.queue.push(userMessage(initialMessage));
    void this.runLoop();
  }

  push(text: string): void { this.queue.push(userMessage(text)); this.wakeIdleWaiters(); }
  /** Stop the session. Aborts any in-flight turn so a hung worker is actually broken, not just left running. */
  stop(): void {
    this.stopped = true;
    this.queue.close();
    this.running = false;
    this.aborter.abort();
    this.wakeIdleWaiters();
  }

  private wakeIdleWaiters(): void {
    if (this.idleWaiters.length === 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  /** Parks until push() or stop() gives the runLoop a reason to re-check. */
  private waitForWork(): Promise<void> {
    return new Promise((resolve) => { this.idleWaiters.push(resolve); });
  }

  private buildOptions(): any {
    const options: any = {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      cwd: this.opts.cwd,
      model: this.opts.model,
      mcpServers: this.opts.mcpServers,
      allowedTools: this.opts.allowedTools,
      disallowedTools: this.opts.disallowedTools,
      env: this.opts.env,
      // Resume the live session if we have one (recover after a usage-limit pause),
      // otherwise fall back to the caller-provided resume id.
      resume: this._sessionId ?? this.opts.resume,
      hooks: this.opts.hooks,
    };
    if (this.opts.systemPromptAppend) {
      options.systemPrompt = { type: 'preset', preset: 'claude_code', append: this.opts.systemPromptAppend };
    }
    return options;
  }

  private now(): Date { return this.opts.now ? this.opts.now() : new Date(); }
  private wait(ms: number): Promise<void> {
    return this.opts.wait ? this.opts.wait(ms) : new Promise((r) => setTimeout(r, ms));
  }

  /** Randomize a connection's idle timeout by +/-WATCHDOG_IDLE_JITTER_RATIO so repeatedly-reconnecting sessions desync over a few cycles instead of retrying in lockstep forever. */
  private jitteredIdleMs(base: number): number {
    const r = this.opts.random ? this.opts.random() : Math.random();
    const factor = 1 + (r * 2 - 1) * WATCHDOG_IDLE_JITTER_RATIO;
    return Math.round(base * factor);
  }

  /** Waits past abort()'s SIGTERM->SIGKILL escalation window before the caller reconnects, so the dying process and its replacement don't run side by side. */
  private graceWait(ms: number): Promise<void> {
    if (this.opts.watchdogGraceWait) return this.opts.watchdogGraceWait(ms);
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      (t as unknown as { unref?: () => void })?.unref?.();
    });
  }

  /** How long to wait before retrying a usage-limited session. */
  private retryDelay(resetAt: Date | null, attempt: number): number {
    const floor = this.opts.retryFloorMs ?? 1_000;
    const max = this.opts.retryMaxMs ?? 6 * 3_600_000; // 6h absolute ceiling
    if (resetAt) {
      const until = resetAt.getTime() - this.now().getTime() + 1_000; // small margin past the reset
      return Math.min(max, Math.max(floor, until));
    }
    const cap = this.opts.retryBackoffCapMs ?? 300_000; // 5 min
    return Math.min(cap, floor * 2 ** Math.max(0, attempt - 1));
  }

  /**
   * Races a pending read (`p`, always `iterator.next()`) against an idle
   * timer and against push()/stop() (`woken`) — WITHOUT abandoning `p`: the
   * caller re-races the *same* promise on a suppressed (exempt-tool) tick or
   * a wake, so a read is never dropped or double-issued against the
   * underlying async iterator. `woken` lets an operator reply immediately
   * shrink an already-armed long "waiting on the operator" idle window back
   * down to the short one — see push()'s comment.
   */
  private async raceIdle<T>(p: Promise<T>, idleMs: number): Promise<{ timedOut: true } | { woken: true } | { timedOut: false; value: T }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wakeResolver: (() => void) | undefined;
    const armIdle = (): Promise<void> => {
      if (this.opts.watchdogWait) return this.opts.watchdogWait(idleMs);
      return new Promise((resolve) => {
        timer = setTimeout(resolve, idleMs);
        (timer as unknown as { unref?: () => void })?.unref?.();
      });
    };
    const armWake = (): Promise<void> => new Promise((resolve) => {
      wakeResolver = resolve;
      this.idleWaiters.push(resolve);
    });
    try {
      return await Promise.race([
        p.then((value) => ({ timedOut: false as const, value })),
        armIdle().then(() => ({ timedOut: true as const })),
        armWake().then(() => ({ woken: true as const })),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      // Whichever branch won, this call's own wake registration must not
      // linger in idleWaiters forever — it would grow unboundedly over a
      // long, chatty connection that never happens to push()/stop() mid-tick.
      if (wakeResolver) {
        const i = this.idleWaiters.indexOf(wakeResolver);
        if (i >= 0) this.idleWaiters.splice(i, 1);
      }
    }
  }

  /**
   * Tracks in-flight watchdog-exempt tool calls (currently: ask_user) by
   * scanning assistant tool_use blocks and user tool_result blocks for a
   * matching id. Best-effort: if the message shape doesn't match what we
   * expect, this silently no-ops and the tool is never marked exempt — the
   * normal idle threshold applies to it instead (fails toward "might
   * reconnect a legitimate ask_user wait" rather than "might never notice a
   * real hang", since the latter is the bug this whole change exists to
   * fix).
   */
  private trackExemptToolUse(msg: any, pending: Set<string>): void {
    const content = msg?.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.id === 'string' && WATCHDOG_EXEMPT_TOOLS.has(block.name)) {
        pending.add(block.id);
      } else if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        pending.delete(block.tool_use_id);
      }
    }
  }

  /**
   * Whether the turn is now "ended" (waiting on the operator, not on the
   * model) for watchdog idle-threshold purposes.
   *
   * CONFIRMED against the real API (a live repro, not assumption): an
   * assistant message's OWN stop_reason is always null — the turn only
   * concludes on a separate, later `result` message, which carries the
   * real stop_reason. (An earlier version of this check looked for
   * stop_reason on the assistant message itself; since that field is
   * always null there, it could never fire — turnEnded silently never
   * became true, and the long waiting threshold never actually applied.)
   *
   * An assistant message with a tool_use means work is about to happen, so
   * the turn is NOT ended. A `result` message means the turn is over, full
   * stop. Anything else (heartbeats, tool results, the system/init
   * handshake, etc.) leaves the current state unchanged.
   */
  private nextTurnEnded(msg: any, current: boolean): boolean {
    if (msg?.type === 'assistant') {
      const content = msg.message?.content;
      if (Array.isArray(content) && content.some((b: any) => b?.type === 'tool_use')) return false;
      return current;
    }
    if (msg?.type === 'result') return true;
    return current;
  }

  private triggerProcessRestart(): void {
    if (this.opts.triggerProcessRestart) { this.opts.triggerProcessRestart(); return; }
    process.kill(process.pid, 'SIGHUP');
  }

  private async runLoop(): Promise<void> {
    let attempt = 0;
    let connectCount = 0;
    // Consecutive reconnects that got zero stream messages — see
    // DEFAULT_WATCHDOG_MAX_CONSECUTIVE_SILENT_RECONNECTS. Spans the whole
    // session's lifetime (not reset per-connection), reset to 0 the moment
    // any connection gets a real message.
    let consecutiveSilentReconnects = 0;
    while (this.running) {
      connectCount++;
      const isReconnect = connectCount > 1;
      const connectStartedAt = Date.now();
      log.debug('session connecting', { sessionId: this._sessionId, connectCount, isReconnect });

      // Per-connection abort, distinct from the whole-session `this.aborter`
      // that stop() uses. The watchdog aborts only the current (hung)
      // attempt and reconnects; it must NOT look like a stop() (which would
      // make the catch block below treat it as a request to end the whole
      // session) or a fatal error. stop() still needs to kill whatever
      // connection is currently open, so cascade its abort into this one.
      const connAborter = new AbortController();
      const cascadeStop = () => connAborter.abort();
      if (this.aborter.signal.aborted) connAborter.abort();
      else this.aborter.signal.addEventListener('abort', cascadeStop);

      const options = this.buildOptions();
      options.abortController = connAborter;
      const stream = this.queryFn({ prompt: this.queue, options });
      const iterator = (stream as AsyncIterable<any>)[Symbol.asyncIterator]();

      let gotFirstMessage = false;
      // tool_use ids of in-flight watchdog-exempt tools (see
      // WATCHDOG_EXEMPT_TOOLS) seen on THIS connection.
      const pendingExemptToolUseIds = new Set<string>();
      // Both drawn once per connection (not per tick) so several sessions that
      // last connected together don't share one fixed retry cadence forever.
      const activeIdleMs = this.jitteredIdleMs(this.opts.watchdogIdleMs ?? DEFAULT_WATCHDOG_IDLE_MS);
      const waitingIdleMs = this.jitteredIdleMs(this.opts.watchdogWaitingIdleMs ?? DEFAULT_WATCHDOG_WAITING_IDLE_MS);
      // True once the most recent assistant message ended the turn (a
      // stop_reason with no outstanding tool_use) with nothing pushed since —
      // i.e. the worker is waiting on the operator, not doing anything.
      // Reset fresh per connection: right after a reconnect we don't yet know
      // the state, so start vigilant (the short threshold) until told otherwise.
      let turnEnded = false;

      try {
        let nextPromise = iterator.next();
        while (true) {
          const idleMs = turnEnded ? waitingIdleMs : activeIdleMs;
          const raced = await this.raceIdle(nextPromise, idleMs);

          if ('woken' in raced) {
            // push()/stop() fired mid-wait. Re-race the SAME pending read —
            // do NOT abandon it: stop()'s queue.close()/abort() can make it
            // resolve very soon (it may already be resolving right now), and
            // the done/error handling below already checks this.running/
            // this.stopped correctly once it does. A live operator reply
            // also lands here: drop back to vigilant so a dead connection
            // doesn't wait out the rest of a long window.
            turnEnded = false;
            continue;
          }

          if (raced.timedOut) {
            if (pendingExemptToolUseIds.size > 0) {
              // Not a hang — a watchdog-exempt tool (ask_user) is still
              // legitimately waiting on something outside the model/CLI's
              // control. Re-arm and keep waiting on the SAME pending read.
              log.debug('session watchdog tick suppressed — exempt tool in flight', {
                sessionId: this._sessionId, connectCount, idleMs,
                pendingExemptToolUseIds: [...pendingExemptToolUseIds],
              });
              // Without this check, stop() during a suppressed (ask_user-in-
              // flight) tick would never actually halt the loop: `running`
              // is only consulted where we `break` out to the outer while,
              // and this branch `continue`s the INNER loop directly. Caught
              // by the test suite OOMing the whole run — with a
              // zero-delay watchdogWait test stub, a stop() that doesn't
              // stop here spins as fast as the microtask queue allows,
              // forever, across every test that runs after it.
              if (!this.running) return;
              continue;
            }

            // stop() can race in during the same tick the idle timer wins —
            // a session merely being torn down normally must not drag the
            // whole process down with it.
            if (!this.running) return;

            if (gotFirstMessage) consecutiveSilentReconnects = 0;
            else consecutiveSilentReconnects++;
            const maxSilent = this.opts.maxConsecutiveSilentReconnects ?? DEFAULT_WATCHDOG_MAX_CONSECUTIVE_SILENT_RECONNECTS;
            if (consecutiveSilentReconnects >= maxSilent) {
              log.error('session watchdog: too many consecutive silent reconnects — restarting the whole process instead', {
                sessionId: this._sessionId, connectCount, consecutiveSilentReconnects, idleMs,
                ...processDiagnostics(),
              });
              connAborter.abort();
              this.onGiveUp?.({ connectCount, consecutiveSilentReconnects });
              this.triggerProcessRestart();
              return;
            }

            log.warn('session watchdog fired — no stream activity, aborting and reconnecting', {
              sessionId: this._sessionId, connectCount, idleMs, turnEnded, gotFirstMessage, consecutiveSilentReconnects,
              connectedForMs: Date.now() - connectStartedAt,
              ...processDiagnostics(),
            });
            connAborter.abort();
            this.onWatchdogRetry?.({ idleMs, connectCount });
            // abort() only sends SIGTERM; wait past the SDK's SIGTERM->SIGKILL
            // escalation window before reconnecting so the dying process and
            // its replacement don't run side by side (see graceWait()).
            await this.graceWait(this.opts.watchdogKillGraceMs ?? DEFAULT_WATCHDOG_KILL_GRACE_MS);
            if (!this.running) return;
            break; // reconnect, same session id
          }

          const msgResult = raced.value;
          if (msgResult.done) {
            // Stream drained normally. The SDK's generator can end on its own —
            // e.g. after a resume whose replayed history already ended cleanly —
            // even though `this.queue` (the streaming-input prompt) is still open
            // and this.running is still true. That is NOT "nothing more to do":
            // this.queue is the one persistent conduit push() writes to for the
            // life of the session, and once nothing is consuming it, every later
            // push() (an operator follow-up) silently vanishes with no error.
            log.warn('session stream drained', {
              sessionId: this._sessionId, connectCount, gotFirstMessage, turnEnded,
              connectedForMs: Date.now() - connectStartedAt, running: this.running, queuePending: this.queue.pending,
            });
            //
            // If stop() already flipped `running` false, we really are done.
            if (!this.running) return;
            // Otherwise only reconnect once there's real work: if a message is
            // already queued (e.g. pushed in the narrow window while the old
            // stream was draining), reconnect immediately; otherwise park until
            // the next push()/stop() wakes us. Parking — instead of an immediate
            // `continue` — is what keeps this from becoming a reconnect storm if
            // the SDK keeps ending the stream instantly for this session: we only
            // ever pay for a fresh queryFn() call in response to actual new work.
            if (!this.queue.pending) {
              const parkedAt = Date.now();
              log.debug('session parking, waiting for next push()', { sessionId: this._sessionId, connectCount });
              await this.waitForWork();
              log.debug('session woke from park', { sessionId: this._sessionId, connectCount, parkedMs: Date.now() - parkedAt });
            }
            break; // re-establish the stream (same queue instance, same session id)
          }

          const msg = msgResult.value;
          // Capture the session id BEFORE logging "first message" below, so
          // that log line actually reflects it on a fresh connection instead
          // of always logging undefined (785ca79 bug: the assignment used to
          // happen after the log call in the same loop body).
          if (msg?.session_id && !this._sessionId) {
            this._sessionId = msg.session_id;
            this.onSessionId?.(msg.session_id);
          }
          if (!gotFirstMessage) {
            gotFirstMessage = true;
            log.debug('session first message on connection', {
              sessionId: this._sessionId, connectCount, isReconnect, waitedMs: Date.now() - connectStartedAt,
            });
          }
          if (attempt > 0) { attempt = 0; this.onResume?.(); } // first message after a pause = recovered
          this.trackExemptToolUse(msg, pendingExemptToolUseIds);
          const prevTurnEnded: boolean = turnEnded;
          turnEnded = this.nextTurnEnded(msg, turnEnded);
          if (turnEnded !== prevTurnEnded) {
            log.debug('session turnEnded transition', {
              sessionId: this._sessionId, connectCount, from: prevTurnEnded, to: turnEnded,
              // result messages carry stop_reason directly on themselves, not
              // nested under .message — see nextTurnEnded's own doc comment.
              msgType: msg?.type, stopReason: msg?.type === 'result' ? msg?.stop_reason : msg?.message?.stop_reason,
              hasToolUse: Array.isArray(msg?.message?.content) && msg.message.content.some((b: any) => b?.type === 'tool_use'),
            });
          }

          nextPromise = iterator.next();
        }
        // loop: re-establish the stream (drained, or watchdog decided to
        // abort and retry) — same queue instance, same session id.
      } catch (err) {
        if (this.stopped) return; // intentional stop()/abort — not a failure to report
        const limit = this.running ? parseUsageLimit(err, this.now()) : null;
        if (!limit) { this.running = false; this.onError?.(err); return; }
        attempt++;
        const delay = this.retryDelay(limit.resetAt, attempt);
        log.warn('session hit usage limit; pausing', {
          resetAt: limit.resetAt?.toISOString() ?? '(unknown)', delayMs: delay, attempt,
        });
        this.onPause?.(limit.resetAt ?? undefined);
        await this.wait(delay);
        // loop: re-establish the stream, resuming the same session id
      } finally {
        this.aborter.signal.removeEventListener('abort', cascadeStop);
      }
    }
  }
}
