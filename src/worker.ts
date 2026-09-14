import { ClaudeSession, type QueryFn } from './session.js';
import { createWorkerToolServer } from './tools/workerTools.js';
import { inspectBashCommand } from './guard.js';
import { applyThreadStatus } from './threadStatus.js';
import { log } from './log.js';
import { PendingQuestions } from './pending.js';
import type { DevEnvLocks } from './devEnvLocks.js';
import type { Gateway } from './mattermost.js';
import type { Db } from './db.js';
import type { Config } from './config.js';
import type { WorkerKind, WorkerRecord } from './types.js';

export const WORKER_SYSTEM_PROMPT = `You are an autonomous engineering worker assigned to ONE feature in this repository.
The human operator is NOT watching your terminal. The ONLY way to communicate with them is via your tools:
- ask_user: ask a question and wait for the reply (use whenever you need a decision, clarification, or input).
- send_update: post progress or share an artifact (spec, plan, diff) as an attachment.
- finish: PROPOSE that the feature is complete and post a summary. This does NOT end the work.
Work autonomously. Decide for yourself when you need the operator.
The operator can't see your terminal, so long stretches of Read/Edit/Bash look identical to being stuck. Send a brief send_update — one short sentence, not a report — whenever you're about to shift to a new phase of work (e.g. "Reading through the gateway retry logic now." / "Starting on the fix." / "Running the test suite."). This is about staying visible, not about writing more per update.
This repository has a SHARED dev environment that only one worker may use at a time. Before you do anything that touches it — starting the dev server, running migrations or seeds, deploying to dev, or running tests that hit the dev environment — call claim_dev. If another worker holds it, claim_dev waits and returns once it's free; that's expected, not an error. Call release_dev the moment you no longer need it so others aren't blocked. Purely local work (reading code, editing files, unit tests that don't touch dev) does NOT need a claim.
Completion is the operator's call, not yours. When you believe the feature is done, call finish to propose it, then stop and wait. The operator will either reply with more changes (address them and call finish again) or close the thread with /done. Never treat yourself as finished until the operator closes the thread.`;

export const INVESTIGATION_SYSTEM_PROMPT = `You are an autonomous engineering worker investigating a production alert. The human operator is NOT watching your terminal; communicate ONLY via your tools (ask_user, send_update, finish).

You have READ-ONLY access to the running system, via Bash:
- Kubernetes: \`kubectl\` (uses $KUBECONFIG; read-only — get/list/describe/logs/top only).
- Prometheus: query at $PROM_URL, e.g. curl -s "$PROM_URL/api/v1/query?query=<expr>" (add "Authorization: Bearer $PROM_TOKEN" if set).
- GlitchTip: the $GLITCHTIP_URL API (add "Authorization: Bearer $GLITCHTIP_TOKEN" if set).

Your job is to DIAGNOSE the root cause. Rules:
- NEVER change anything on the cluster or in production. Read-only only — no apply/delete/edit/patch/scale/rollout/restart/cordon. (Cluster RBAC enforces this; don't even attempt writes.)
- If a code fix is warranted and you were given a repository, propose it as changes IN THIS REPOSITORY and describe them — do NOT deploy. If you were not given a repo (scratch working directory), diagnose and say which repo/service a fix belongs in.
- Use send_update to share findings, logs, and metrics as you go. Also send a brief one-line send_update whenever you shift focus (e.g. "Checking the envoy rollout config next.") — a sentence, not a report; the operator can't see your terminal.
- When you have a diagnosis (and a proposed fix if applicable), call finish with a clear summary. Completion is the operator's decision — after finish, wait; they will reply with follow-ups or close the thread with /done.`;

export interface WorkerDeps {
  queryFn: QueryFn;
  gateway: Gateway;
  db: Db;
  pending: PendingQuestions;
  cfg: Config;
  devLocks: DevEnvLocks;
  record: WorkerRecord;
  onFinish: () => void;
  /** Test seam: override the usage-limit retry wait so tests don't sleep. */
  wait?: (ms: number) => Promise<void>;
}

export class Worker {
  private session!: ClaudeSession;
  constructor(private deps: WorkerDeps) {}

  get id(): string { return this.deps.record.id; }
  get kind(): WorkerKind { return this.deps.record.kind; }

  /**
   * Defense-in-depth for investigation workers: a PreToolUse hook that denies Bash
   * commands mutating the cluster/monitoring backends. `permissionDecision: 'deny'`
   * blocks the call even under bypassPermissions. Cluster RBAC remains the real boundary.
   */
  private clusterWriteGuardHooks(): Record<string, unknown> | undefined {
    if (this.deps.record.kind !== 'investigation') return undefined;
    const workerId = this.deps.record.id;
    const preToolUse = async (input: { tool_name: string; tool_input: unknown }) => {
      if (input.tool_name !== 'Bash') return { continue: true };
      const command = (input.tool_input as { command?: string })?.command ?? '';
      const verdict = inspectBashCommand(command);
      if (!verdict.blocked) return { continue: true };
      log.warn('blocked cluster write', { worker: workerId, cmd: command });
      return {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.reason },
      };
    };
    return { PreToolUse: [{ matcher: 'Bash', hooks: [preToolUse] }] };
  }

  private buildSession(resume?: string): ClaudeSession {
    const { server, toolNames } = createWorkerToolServer({
      gateway: this.deps.gateway, db: this.deps.db, pending: this.deps.pending,
      workerId: this.deps.record.id, threadRootId: this.deps.record.threadRootId,
      repoName: this.deps.record.repoName, kind: this.deps.record.kind, devLocks: this.deps.devLocks,
    });
    const { record, gateway } = this.deps;
    return new ClaudeSession(
      this.deps.queryFn,
      {
        cwd: record.repoPath,
        systemPromptAppend: record.kind === 'investigation' ? INVESTIGATION_SYSTEM_PROMPT : WORKER_SYSTEM_PROMPT,
        model: this.deps.cfg.model,
        mcpServers: { worker: server },
        allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', ...toolNames],
        env: { ...process.env as Record<string, string>, MCP_TIMEOUT: String(this.deps.cfg.askUserTimeoutMs) },
        resume,
        hooks: this.clusterWriteGuardHooks(),
        wait: this.deps.wait,
        watchdogIdleMs: this.deps.cfg.watchdogIdleMs,
        watchdogWaitingIdleMs: this.deps.cfg.watchdogWaitingIdleMs,
        maxConsecutiveSilentReconnects: this.deps.cfg.maxConsecutiveSilentReconnects,
        // Only these reach the operator directly — Bash/Read/Edit/Glob/Grep
        // and claim_dev/release_dev don't. Real incident: a worker used Bash
        // to investigate, then gave its actual answer as plain text with no
        // send_update call — "any tool use counts" wrongly treated that as
        // already-communicated.
        communicationToolNames: ['mcp__worker__ask_user', 'mcp__worker__send_update', 'mcp__worker__finish'],
      },
      (id) => { log.debug('worker session id', { worker: record.id, session: id }); this.deps.db.updateWorker(record.id, { sessionId: id }); },
      (err) => {
        log.error('worker session error', { worker: record.id, err: err instanceof Error ? err.message : String(err) });
        this.deps.db.updateWorker(record.id, { status: 'failed' });
        void gateway.post({ text: `Worker hit a fatal session error: ${err instanceof Error ? err.message : String(err)}`, threadRootId: record.threadRootId });
        void applyThreadStatus(gateway, record.threadRootId, 'failed');
        this.deps.onFinish();
      },
      // Usage/rate limit: the session pauses and auto-resumes — not a failure.
      (resetAt) => {
        const when = resetAt ? ` resuming ~${resetAt.toISOString().slice(11, 16)} UTC` : ' will retry shortly';
        log.warn('worker paused on usage limit', { worker: record.id, resetAt: resetAt?.toISOString() ?? '(unknown)' });
        void gateway.post({ text: `⏳ Paused — hit the usage limit,${when}.`, threadRootId: record.threadRootId });
        void applyThreadStatus(gateway, record.threadRootId, 'waiting');
      },
      () => {
        log.info('worker resumed after usage limit', { worker: record.id });
        void gateway.post({ text: '▶️ Resumed — usage available again.', threadRootId: record.threadRootId });
        void applyThreadStatus(gateway, record.threadRootId, 'running');
      },
      // Inactivity watchdog fired: the connection stopped producing any
      // stream message for `idleMs` while a turn was nominally in progress,
      // so we aborted just that connection and reconnected. Post this so a
      // worker that keeps quietly recovering is visible instead of looking
      // like nothing happened — see session.ts's DEFAULT_WATCHDOG_IDLE_MS.
      ({ idleMs }) => {
        const minutes = Math.round(idleMs / 60_000);
        log.warn('worker turn watchdog fired — reconnecting', { worker: record.id, idleMs });
        void gateway.post({ text: `⚠️ This turn seemed stuck (no activity for ~${minutes} min) — reconnecting and retrying automatically.`, threadRootId: record.threadRootId });
      },
      // Gave up on in-process recovery: reconnecting repeatedly produced
      // zero output, so the whole process is restarting instead. That
      // restart will itself reconnect this worker — post here so the
      // operator sees why it went quiet for longer than a normal retry,
      // rather than it looking unexplained.
      ({ consecutiveSilentReconnects }) => {
        log.error('worker gave up on in-process recovery — restarting the whole process', { worker: record.id, consecutiveSilentReconnects });
        void gateway.post({ text: `🔴 This session produced no output across ${consecutiveSilentReconnects} reconnect attempts — restarting the whole supervisor process to recover. It will pick back up here shortly.`, threadRootId: record.threadRootId });
      },
      // The system prompt says tools are the only way to communicate, but
      // nothing enforces that — the model can end a turn with plain text and
      // no tool call, which would otherwise be completely invisible (no
      // send_update/ask_user/finish ever ran). Surface it anyway so a reply
      // is never silently lost.
      (text) => {
        log.warn('worker turn ended with plain text and no tool call — posting fallback', { worker: record.id, preview: text.slice(0, 200) });
        void gateway.post({ text: `💬 ${text}`, threadRootId: record.threadRootId });
      },
    );
  }

  start(): void {
    this.session = this.buildSession();
    this.session.start(this.deps.record.task);
  }

  startResumed(): void {
    this.session = this.buildSession(this.deps.record.sessionId ?? undefined);
    this.session.start('You were reconnected after a restart. Continue where you left off.');
  }

  inject(text: string, filePaths: string[]): void {
    const suffix = filePaths.length ? `\n\nAttached files (local paths):\n${filePaths.join('\n')}` : '';
    this.session.push(text + suffix);
  }

  stop(): void { this.session?.stop(); }
  /** Graceful counterpart to stop() — see ClaudeSession.drainAndStop's doc comment. */
  async stopGracefully(): Promise<void> { await this.session?.drainAndStop(); }
}
