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

// Same idea as DEFAULT_WATCHDOG_MAX_CONSECUTIVE_SILENT_RECONNECTS above, but
// for reconnects that fire while turnEnded=true (waiting on the operator,
// nothing queued) — EVERY such reconnect gets zero messages by design (a
// resumed connection with nothing to send never emits anything at all), so
// it needs its own, much longer ceiling rather than sharing the short one
// tuned for "a turn was actively in progress and went dark". At the default
// ~3h waitingIdleMs (jittered), 8 cycles is roughly a day of total silence
// from both the connection AND the operator before giving up — without this,
// a connection that's genuinely, permanently dead while turnEnded=true would
// reconnect forever with no backstop at all, the same unbounded-silence
// failure mode this whole mechanism exists to catch, just in this state.
export const DEFAULT_WATCHDOG_MAX_CONSECUTIVE_WAITING_RECONNECTS = 8;

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
  // Same idea, for reconnects while turnEnded=true — see
  // DEFAULT_WATCHDOG_MAX_CONSECUTIVE_WAITING_RECONNECTS.
  maxConsecutiveWaitingReconnects?: number;
  // Test seam: what to call instead of actually restarting the process.
  // Defaults to sending this process SIGHUP (installSelfReload's handler).
  triggerProcessRestart?: () => void;
  // Tool names that themselves reach the operator (post to Mattermost, or
  // equivalent) — used to decide whether a turn already communicated before
  // onSilentTurnEnd's fallback considers it silent. Real incident: a worker
  // used Bash to investigate, then gave its actual answer as plain text with
  // no send_update call — "was ANY tool used" wrongly treated that as
  // already-communicated (Bash/Read/Edit aren't), so the answer never
  // reached the operator. Undefined means "any tool use counts" (the old,
  // looser behavior) — callers that care should pass their real
  // communication tool names (see worker.ts/supervisor.ts).
  communicationToolNames?: string[];
}

// Minimal async queue: an async-iterable you can push to and close.
// Exported for direct unit testing — the reconnect-delivery invariant below
// is awkward to exercise reliably through the full ClaudeSession + watchdog
// machinery (timing-dependent races), but trivial to test in isolation here.
export class MessageQueue<T> implements AsyncIterable<T> {
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
        // Discard any resolver already waiting here before registering this
        // one. Only one connection is ever genuinely live at a time (the
        // runLoop never has two concurrent pending reads on the same queue),
        // so a resolver still sitting here when a NEW one registers can only
        // belong to a connection that's already been abandoned by a
        // reconnect — its generator may still be running in the background
        // (nothing forcibly kills it), but nothing should ever again be
        // delivered to it. Real incident: without this, push() always
        // resolves the OLDEST pending resolver first via shift() below, so
        // after N abandoned reconnects the next N operator messages would be
        // silently consumed by those dead connections instead of the live one
        // still actually reading stdin.
        this.resolvers.length = 0;
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
    // Fired when a turn ends (a `result` message) and NO tool_use ever
    // appeared anywhere in that turn — i.e. the model replied with plain
    // text only. Callers (worker.ts/supervisor.ts) rely entirely on tool
    // calls (send_update/ask_user/finish, post_to_channel) to post to
    // Mattermost; a pure-text reply is otherwise never surfaced anywhere,
    // even though the watchdog correctly treats it as a legitimate
    // "waiting on the operator" state, not a hang. Real incident: a worker's
    // reply to an operator instruction sent at 16:00:01 ended
    // stopReason=end_turn hasToolUse=false and nothing was ever posted.
    private onSilentTurnEnd?: (text: string) => void,
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
    log.debug('session stop: aborting', { sessionId: this._sessionId });
    this.aborter.abort();
    log.debug('session stop: aborted', { sessionId: this._sessionId });
    this.wakeIdleWaiters();
  }

  /**
   * Graceful variant of stop(), for a planned shutdown (self-reload, process exit) rather
   * than an operator-initiated /done. stop() closes the queue and aborts immediately,
   * discarding anything buffered in it that the runLoop hasn't picked up yet — fine for an
   * intentional /done, but real incident: a SIGHUP self-reload raced a push() that had just
   * landed in the queue and not yet been read by the SDK's input generator; stop() dropped
   * it, and --resume on the respawned process only recovers messages that were actually
   * handed to the model, so it was lost for good with no error anywhere. Wait briefly for
   * the queue to drain (i.e. for runLoop's SDK-facing generator to actually pick up what's
   * buffered) before doing the same abort — a bounded wait, not a guarantee: if the runLoop
   * is itself wedged this still falls through to stop() rather than hanging the shutdown.
   */
  async drainAndStop(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.queue.pending && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this.stop();
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
    // Consecutive waiting-threshold reconnects (turnEnded=true, nothing
    // queued) with no operator engagement in between — see
    // DEFAULT_WATCHDOG_MAX_CONSECUTIVE_WAITING_RECONNECTS. Separate ceiling
    // from consecutiveSilentReconnects above: this state is EXPECTED to be
    // silent every cycle, so it needs its own, much longer bound rather than
    // sharing one tuned for "a turn was actively in progress and went dark".
    let consecutiveWaitingReconnects = 0;
    // Guards onSilentTurnEnd against firing more than once for the SAME
    // turn: a resumed connection (watchdog reconnect, or the long
    // waiting-threshold timeout) can re-surface an already-ended turn's
    // result on the fresh stream — see the 'session stream drained' comment
    // above on resume replay. Session-lifetime scope (not reset per
    // connection like turnEnded/turnCommunicated below), only reset by push().
    let reportedSilentTurn = false;
    // True once the most recent assistant message ended the turn (a
    // stop_reason with no outstanding tool_use) with nothing pushed since —
    // i.e. the worker is waiting on the operator, not doing anything.
    // Session-lifetime scope (survives reconnects), only reset by push():
    // resetting this to "vigilant" on every reconnect defeats the entire
    // point of the long waiting threshold below. Real incident: a worker
    // correctly waiting on the operator reconnects once when the long
    // threshold elapses (routine — nothing queued, so it gets zero
    // messages); if that reconnect reset back to vigilant, it starts
    // reconnecting every ~20min with nothing to say, racing toward
    // maxConsecutiveSilentReconnects and forcing an unwanted full process
    // restart roughly every hour even though nothing was ever hung.
    //
    // A reconnect that fires while turnEnded is true never counts toward
    // consecutiveSilentReconnects and never notifies — see the `if
    // (turnEnded)` branch in the timedOut handling below. A connection that's
    // genuinely, permanently dead here is indistinguishable from a healthy
    // idle one (both produce silence, since a resumed connection with
    // nothing queued never emits anything at all — confirmed live), and a
    // real operator reply still recovers fast regardless via the 'woken'
    // branch, so there is no detection/escalation ceiling to trade off here
    // at all anymore.
    let turnEnded = false;
    // True once any assistant message in the CURRENT turn has carried a
    // tool_use block that counts as reaching the operator — see
    // communicationToolNames's doc comment. Same session-lifetime scope as
    // turnEnded, for the same reason — see onSilentTurnEnd's doc comment on
    // the constructor.
    let turnCommunicated = false;
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
            turnCommunicated = false;
            reportedSilentTurn = false;
            consecutiveWaitingReconnects = 0;
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

            if (turnEnded) {
              // The LONG threshold elapsed while legitimately waiting on the
              // operator with nothing queued — this is the expected shape of
              // "correctly idle", not a hang: a resumed connection with
              // nothing to send never emits anything at all, so EVERY such
              // reconnect gets zero messages by design. Real incident: before
              // this branch existed, each one still counted toward
              // consecutiveSilentReconnects and posted a "seemed stuck"
              // notification, eventually force-restarting the whole process
              // every few hours for no actual reason — pure noise. Quietly
              // refresh the connection instead: no per-cycle counting against
              // the mid-turn-hang counter, no notification. Reaching a clean
              // turn end is itself evidence of health, so also zero that
              // counter — otherwise a stale partial count from an earlier,
              // fully-resolved mid-turn hang could sit through an arbitrarily
              // long healthy idle period and then combine with one unrelated
              // later hang to trip a premature restart.
              consecutiveSilentReconnects = 0;
              // Still tracked with its OWN, much longer ceiling: without any
              // backstop at all, a connection that's genuinely, permanently
              // dead while turnEnded=true would silently reconnect forever —
              // exactly the unbounded-silence failure mode
              // maxConsecutiveSilentReconnects exists to catch in the first
              // place (see the "37 consecutive reconnects over 13 hours"
              // incident above), just in this state instead. A real operator
              // reply still recovers immediately regardless (see the 'woken'
              // branch above and the queue.pending check at connection start)
              // — this ceiling only ever matters for total, sustained
              // silence from BOTH sides.
              consecutiveWaitingReconnects++;
              const maxWaiting = this.opts.maxConsecutiveWaitingReconnects ?? DEFAULT_WATCHDOG_MAX_CONSECUTIVE_WAITING_RECONNECTS;
              if (consecutiveWaitingReconnects >= maxWaiting) {
                log.error('session watchdog: too many consecutive waiting-threshold reconnects with no operator engagement — restarting the whole process instead', {
                  sessionId: this._sessionId, connectCount, consecutiveWaitingReconnects, idleMs,
                  ...processDiagnostics(),
                });
                connAborter.abort();
                this.onGiveUp?.({ connectCount, consecutiveSilentReconnects: consecutiveWaitingReconnects });
                this.triggerProcessRestart();
                return;
              }
              // log.info (not debug): this path is deliberately silent on
              // Mattermost and never counts toward the mid-turn-hang escalation,
              // but it should still leave a trace in LOG_FILE regardless of
              // LOG_LEVEL configuration, since it's otherwise unobservable.
              log.info('session watchdog: waiting-threshold reconnect (routine, not a hang)', {
                sessionId: this._sessionId, connectCount, idleMs, gotFirstMessage, consecutiveWaitingReconnects,
              });
              connAborter.abort();
              await this.graceWait(this.opts.watchdogKillGraceMs ?? DEFAULT_WATCHDOG_KILL_GRACE_MS);
              if (!this.running) return;
              break; // reconnect, same session id — no counting against the mid-turn-hang path, no notify
            }

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
          if (msg?.type === 'assistant' && Array.isArray(msg?.message?.content) && msg.message.content.some((b: any) =>
            b?.type === 'tool_use' && (!this.opts.communicationToolNames || this.opts.communicationToolNames.includes(b.name))
          )) {
            turnCommunicated = true;
          }
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
            if (msg?.type === 'result' && !turnCommunicated && !reportedSilentTurn && typeof msg?.result === 'string' && msg.result.trim()) {
              this.onSilentTurnEnd?.(msg.result);
              reportedSilentTurn = true;
            }
            if (msg?.type === 'result') turnCommunicated = false; // next turn starts fresh
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
