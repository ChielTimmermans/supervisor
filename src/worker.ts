import { ClaudeSession, type QueryFn } from './session.js';
import { createWorkerToolServer } from './tools/workerTools.js';
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
- finish: post a final summary when the feature is complete.
Work autonomously. Decide for yourself when you need the operator. When done, call finish.`;

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

  private buildSession(resume?: string): ClaudeSession {
    const { server, toolNames } = createWorkerToolServer({
      gateway: this.deps.gateway, db: this.deps.db, pending: this.deps.pending,
      workerId: this.deps.record.id, threadRootId: this.deps.record.threadRootId,
      onFinish: this.deps.onFinish,
    });
    return new ClaudeSession(
      this.deps.queryFn,
      {
        cwd: this.deps.record.repoPath,
        systemPromptAppend: WORKER_SYSTEM_PROMPT,
        model: this.deps.cfg.model,
        mcpServers: { worker: server },
        allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', ...toolNames],
        env: { ...process.env as Record<string, string>, MCP_TIMEOUT: String(this.deps.cfg.askUserTimeoutMs) },
        resume,
      },
      (id) => { log.debug('worker session id', { worker: this.deps.record.id, session: id }); this.deps.db.updateWorker(this.deps.record.id, { sessionId: id }); },
      (err) => {
        log.error('worker session error', { worker: this.deps.record.id, err: err instanceof Error ? err.message : String(err) });
        this.deps.db.updateWorker(this.deps.record.id, { status: 'failed' });
        void this.deps.gateway.post({ text: `Worker hit a fatal session error: ${err instanceof Error ? err.message : String(err)}`, threadRootId: this.deps.record.threadRootId });
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
