import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { route } from './router.js';
import { PendingQuestions } from './pending.js';
import { Worker } from './worker.js';
import { Supervisor } from './supervisor.js';
import { createSupervisorToolServer, type SupervisorToolDeps } from './tools/supervisorTools.js';
import type { QueryFn } from './session.js';
import type { Gateway } from './mattermost.js';
import type { Db } from './db.js';
import type { Config } from './config.js';
import type { IncomingPost } from './types.js';

export interface BridgeDeps { queryFn: QueryFn; gateway: Gateway; db: Db; cfg: Config }

export class Bridge {
  private pending: PendingQuestions;
  private workers = new Map<string, Worker>();
  private supervisor!: Supervisor;
  constructor(private deps: BridgeDeps) {
    this.pending = new PendingQuestions(deps.db);
  }

  async start(): Promise<void> {
    await mkdir(this.deps.cfg.attachmentDir, { recursive: true });
    await this.deps.gateway.connect((p) => { void this.handlePost(p); });

    // Reconcile persisted workers.
    for (const rec of this.deps.db.listWorkers()) {
      if (rec.status === 'finished' || rec.status === 'failed') continue;
      if (!rec.sessionId) { this.markFailed(rec.id, 'No session to resume.'); continue; }
      const worker = new Worker({
        queryFn: this.deps.queryFn, gateway: this.deps.gateway, db: this.deps.db,
        pending: this.pending, cfg: this.deps.cfg, record: rec,
        onFinish: () => {
          const w = this.workers.get(rec.id);
          this.workers.delete(rec.id);
          if (w) setImmediate(() => w.stop());
        },
      });
      try {
        worker.startResumed();
        this.workers.set(rec.id, worker);
        const openQ = this.deps.db.getOpenQuestionForWorker(rec.id);
        if (openQ) {
          this.deps.db.resolvePendingQuestion(openQ.id, '(cleared on restart)');
          void this.deps.gateway.post({
            text: 'I was restarted and lost the question I had open. Please re-send your answer — I will use it, or re-ask if I still need input.',
            threadRootId: rec.threadRootId,
          });
        }
      }
      catch { this.markFailed(rec.id, 'Could not resume session.'); }
    }

    // Start / resume the supervisor.
    const toolServer = createSupervisorToolServer(this.supervisorDeps());
    this.supervisor = new Supervisor({ queryFn: this.deps.queryFn, db: this.deps.db, cfg: this.deps.cfg, toolServer });
    const active = this.deps.db.listWorkers().filter((w) => w.status === 'running' || w.status === 'waiting');
    this.supervisor.start(`You are online. Active workers: ${active.length ? active.map((w) => `${w.id}(${w.repoName})`).join(', ') : 'none'}.`);
  }

  private supervisorDeps(): SupervisorToolDeps {
    return {
      gateway: this.deps.gateway, db: this.deps.db, cfg: this.deps.cfg,
      spawnWorker: (a) => this.spawnWorker(a),
      stopWorker: (id) => this.stopWorker(id),
    };
  }

  private spawnWorker(args: { repo: string; task: string; threadRootId: string }): { ok: true; workerId: string } | { ok: false; reason: string } {
    const repo = this.deps.cfg.repos[args.repo];
    if (!repo) return { ok: false, reason: `Unknown repo ${args.repo}` };
    const active = this.workers.size;
    if (active >= this.deps.cfg.workerConcurrency) return { ok: false, reason: 'Concurrency limit reached' };

    const id = 'w-' + randomUUID().slice(0, 8);
    const rec = this.deps.db.createWorker({ id, threadRootId: args.threadRootId, repoName: args.repo, repoPath: repo.path, task: args.task });
    const worker = new Worker({
      queryFn: this.deps.queryFn, gateway: this.deps.gateway, db: this.deps.db,
      pending: this.pending, cfg: this.deps.cfg, record: rec,
      onFinish: () => {
        const w = this.workers.get(id);
        this.workers.delete(id);
        if (w) setImmediate(() => w.stop());
      },
    });
    worker.start();
    this.workers.set(id, worker);
    void this.deps.gateway.post({ text: `Started a worker in **${args.repo}** for this feature.`, threadRootId: args.threadRootId });
    return { ok: true, workerId: id };
  }

  private stopWorker(id: string): void {
    this.workers.get(id)?.stop();
    this.workers.delete(id);
    this.deps.db.updateWorker(id, { status: 'finished' });
  }

  private markFailed(id: string, reason: string): void {
    this.deps.db.updateWorker(id, { status: 'failed' });
    const rec = this.deps.db.getWorker(id);
    if (rec) void this.deps.gateway.post({ text: `Worker could not be restored: ${reason}`, threadRootId: rec.threadRootId });
  }

  private async downloadAttachments(post: IncomingPost): Promise<string[]> {
    const out: string[] = [];
    for (const fid of post.fileIds) {
      const dest = path.join(this.deps.cfg.attachmentDir, `${post.id}-${fid}`);
      out.push(await this.deps.gateway.downloadFile(fid, dest));
    }
    return out;
  }

  async handlePost(post: IncomingPost): Promise<void> {
    const files = post.fileIds.length ? await this.downloadAttachments(post) : [];
    const action = route(post, {
      getWorkerByThread: (t) => this.deps.db.getWorkerByThread(t),
      hasOpenQuestion: (wid) => this.pending.hasOpen(wid),
    });

    if (action.kind === 'supervisor') {
      const attach = files.length ? `\nAttached files: ${files.join(', ')}` : '';
      const kind = post.rootId === '' ? 'New top-level message' : 'Thread message (no worker)';
      this.supervisor.push(`${kind} in thread ${post.rootId || post.id} from the operator:\n"${post.message}"${attach}`);
      return;
    }
    if (action.kind === 'resolve_question') {
      const answer = files.length ? `${post.message}\nAttached files:\n${files.join('\n')}` : post.message;
      this.pending.resolve(action.workerId, answer);
      return;
    }
    if (action.kind === 'inject_worker') {
      this.workers.get(action.workerId)?.inject(post.message, files);
    }
  }
}
