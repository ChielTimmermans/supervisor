import { ClaudeSession, type QueryFn } from './session.js';
import { createWorkerToolServer } from './tools/workerTools.js';
import { inspectBashCommand } from './guard.js';
import { applyThreadStatus } from './threadStatus.js';
import { log } from './log.js';
import { PendingQuestions } from './pending.js';
import type { Gateway } from './mattermost.js';
import type { Db } from './db.js';
import type { Config } from './config.js';
import type { WorkerRecord } from './types.js';

export const WORKER_SYSTEM_PROMPT = `You are an autonomous engineering worker assigned to ONE feature in this repository.
The human operator is NOT watching your terminal. The ONLY way to communicate with them is via your tools:
- ask_user: ask a question and wait for the reply (use whenever you need a decision, clarification, or input).
- send_update: post progress or share an artifact (spec, plan, diff) as an attachment.
- finish: PROPOSE that the feature is complete and post a summary. This does NOT end the work.
Work autonomously. Decide for yourself when you need the operator.
Completion is the operator's call, not yours. When you believe the feature is done, call finish to propose it, then stop and wait. The operator will either reply with more changes (address them and call finish again) or close the thread with /done. Never treat yourself as finished until the operator closes the thread.`;

export const INVESTIGATION_SYSTEM_PROMPT = `You are an autonomous engineering worker investigating a production alert. The human operator is NOT watching your terminal; communicate ONLY via your tools (ask_user, send_update, finish).

You have READ-ONLY access to the running system, via Bash:
- Kubernetes: \`kubectl\` (uses $KUBECONFIG; read-only — get/list/describe/logs/top only).
- Prometheus: query at $PROM_URL, e.g. curl -s "$PROM_URL/api/v1/query?query=<expr>" (add "Authorization: Bearer $PROM_TOKEN" if set).
- GlitchTip: the $GLITCHTIP_URL API (add "Authorization: Bearer $GLITCHTIP_TOKEN" if set).

Your job is to DIAGNOSE the root cause. Rules:
- NEVER change anything on the cluster or in production. Read-only only — no apply/delete/edit/patch/scale/rollout/restart/cordon. (Cluster RBAC enforces this; don't even attempt writes.)
- If a code fix is warranted and you were given a repository, propose it as changes IN THIS REPOSITORY and describe them — do NOT deploy. If you were not given a repo (scratch working directory), diagnose and say which repo/service a fix belongs in.
- Use send_update to share findings, logs, and metrics as you go.
- When you have a diagnosis (and a proposed fix if applicable), call finish with a clear summary. Completion is the operator's decision — after finish, wait; they will reply with follow-ups or close the thread with /done.`;

export interface WorkerDeps {
  queryFn: QueryFn;
  gateway: Gateway;
  db: Db;
  pending: PendingQuestions;
  cfg: Config;
  record: WorkerRecord;
  onFinish: () => void;
}

export class Worker {
  private session!: ClaudeSession;
  constructor(private deps: WorkerDeps) {}

  get id(): string { return this.deps.record.id; }

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
    });
    return new ClaudeSession(
      this.deps.queryFn,
      {
        cwd: this.deps.record.repoPath,
        systemPromptAppend: this.deps.record.kind === 'investigation' ? INVESTIGATION_SYSTEM_PROMPT : WORKER_SYSTEM_PROMPT,
        model: this.deps.cfg.model,
        mcpServers: { worker: server },
        allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', ...toolNames],
        env: { ...process.env as Record<string, string>, MCP_TIMEOUT: String(this.deps.cfg.askUserTimeoutMs) },
        resume,
        hooks: this.clusterWriteGuardHooks(),
      },
      (id) => { log.debug('worker session id', { worker: this.deps.record.id, session: id }); this.deps.db.updateWorker(this.deps.record.id, { sessionId: id }); },
      (err) => {
        log.error('worker session error', { worker: this.deps.record.id, err: err instanceof Error ? err.message : String(err) });
        this.deps.db.updateWorker(this.deps.record.id, { status: 'failed' });
        void this.deps.gateway.post({ text: `Worker hit a fatal session error: ${err instanceof Error ? err.message : String(err)}`, threadRootId: this.deps.record.threadRootId });
        void applyThreadStatus(this.deps.gateway, this.deps.record.threadRootId, 'failed');
        this.deps.onFinish();
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
}
