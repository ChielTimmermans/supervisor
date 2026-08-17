import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { route } from './router.js';
import { parseAlert } from './alerts.js';
import { PendingQuestions } from './pending.js';
import { Worker } from './worker.js';
import { Supervisor } from './supervisor.js';
import { createSupervisorToolServer, type SupervisorToolDeps } from './tools/supervisorTools.js';
import { applyThreadStatus } from './threadStatus.js';
import { log, preview } from './log.js';
import type { QueryFn } from './session.js';
import type { Gateway } from './mattermost.js';
import type { Db } from './db.js';
import type { Config } from './config.js';
import type { IncomingPost, WorkerRecord, AlertEvent, AlertSource } from './types.js';

export interface BridgeDeps { queryFn: QueryFn; gateway: Gateway; db: Db; cfg: Config }

export class Bridge {
  private pending: PendingQuestions;
  private workers = new Map<string, Worker>();
  private ingest: Map<string, AlertSource>;
  private supervisor!: Supervisor;
  constructor(private deps: BridgeDeps) {
    this.pending = new PendingQuestions(deps.db);
    this.ingest = new Map(deps.cfg.ingestChannels.map((c) => [c.channelId, c.source]));
  }

  async start(): Promise<void> {
    await mkdir(this.deps.cfg.attachmentDir, { recursive: true });
    await this.deps.gateway.connect((p) => { void this.handlePost(p); });

    // Reconcile persisted workers.
    const resumable = this.deps.db.listWorkers().filter((w) => w.status === 'running' || w.status === 'waiting');
    if (resumable.length) log.info('reconciling workers', { count: resumable.length });
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
        void applyThreadStatus(this.deps.gateway, rec.threadRootId, rec.status === 'waiting' ? 'waiting' : 'running');
        log.info('resumed worker', { worker: rec.id, repo: rec.repoName, thread: rec.threadRootId });
        const openQ = this.deps.db.getOpenQuestionForWorker(rec.id);
        if (openQ) {
          this.deps.db.resolvePendingQuestion(openQ.id, '(cleared on restart)');
          log.info('cleared stale question on restart', { worker: rec.id });
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
    log.info('supervisor session started', { activeWorkers: active.length });
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
    if (!repo) { log.warn('spawn rejected: unknown repo', { repo: args.repo }); return { ok: false, reason: `Unknown repo ${args.repo}` }; }
    const active = this.workers.size;
    if (active >= this.deps.cfg.workerConcurrency) { log.warn('spawn rejected: at capacity', { active, cap: this.deps.cfg.workerConcurrency }); return { ok: false, reason: 'Concurrency limit reached' }; }

    const id = 'w-' + randomUUID().slice(0, 8);
    const rec = this.deps.db.createWorker({ id, threadRootId: args.threadRootId, repoName: args.repo, repoPath: repo.path, task: args.task, kind: 'feature' });
    this.launchWorker(rec);
    log.info('spawned worker', { worker: id, repo: args.repo, thread: args.threadRootId, task: preview(args.task, 80) });
    void this.deps.gateway.post({ text: `Started a worker in **${args.repo}** for this feature.`, threadRootId: args.threadRootId });
    return { ok: true, workerId: id };
  }

  /** Construct, start, and track a worker from a persisted record. */
  private launchWorker(rec: WorkerRecord): void {
    const worker = new Worker({
      queryFn: this.deps.queryFn, gateway: this.deps.gateway, db: this.deps.db,
      pending: this.pending, cfg: this.deps.cfg, record: rec,
      onFinish: () => {
        const w = this.workers.get(rec.id);
        this.workers.delete(rec.id);
        if (w) setImmediate(() => w.stop());
      },
    });
    worker.start();
    this.workers.set(rec.id, worker);
    void applyThreadStatus(this.deps.gateway, rec.threadRootId, 'running');
  }

  private stopWorker(id: string): void {
    this.workers.get(id)?.stop();
    this.workers.delete(id);
    this.deps.db.updateWorker(id, { status: 'finished' });
    log.info('stopped worker', { worker: id });
  }

  /** Operator explicitly closes a feature/investigation (via `/done`): tear down and confirm. */
  private closeWorker(id: string): void {
    const rec = this.deps.db.getWorker(id);
    this.workers.get(id)?.stop();
    this.workers.delete(id);
    this.deps.db.updateWorker(id, { status: 'finished' });
    this.pending.cancel(id);
    if (rec) {
      const inc = this.deps.db.getIncidentByThread(rec.threadRootId);
      if (inc && inc.status !== 'closed') this.deps.db.setIncidentStatus(inc.id, 'closed');
      void this.deps.gateway.post({ text: 'Closed this thread. 🎉', threadRootId: rec.threadRootId });
      void applyThreadStatus(this.deps.gateway, rec.threadRootId, 'done');
    }
    log.info('closed worker (operator /done)', { worker: id });
  }

  private markFailed(id: string, reason: string): void {
    log.warn('worker failed', { worker: id, reason });
    this.deps.db.updateWorker(id, { status: 'failed' });
    const rec = this.deps.db.getWorker(id);
    if (rec) {
      void this.deps.gateway.post({ text: `Worker could not be restored: ${reason}`, threadRootId: rec.threadRootId });
      void applyThreadStatus(this.deps.gateway, rec.threadRootId, 'failed');
    }
  }

  private async downloadAttachments(post: IncomingPost): Promise<string[]> {
    const out: string[] = [];
    for (const fid of post.fileIds) {
      const dest = path.join(this.deps.cfg.attachmentDir, `${post.id}-${fid}`);
      out.push(await this.deps.gateway.downloadFile(fid, dest));
    }
    return out;
  }

  private pushToSupervisor(post: IncomingPost, files: string[]): void {
    const attach = files.length ? `\nAttached files: ${files.join(', ')}` : '';
    const kind = post.rootId === '' ? 'New top-level message' : 'Thread message (no active worker)';
    this.supervisor.push(`${kind} in thread ${post.rootId || post.id} from the operator:\n"${post.message}"${attach}`);
  }

  async handlePost(post: IncomingPost): Promise<void> {
    // Posts in an ingest channel are monitoring alerts, not operator conversation.
    const alertSource = this.ingest.get(post.channelId);
    if (alertSource) { await this.handleAlert(post, alertSource); return; }

    // Operator close command: `/done` (or `/close`) in a thread closes that thread's live worker.
    const cmd = post.message.trim().toLowerCase();
    if (post.rootId !== '' && (cmd === '/done' || cmd === '/close')) {
      const w = this.deps.db.getWorkerByThread(post.rootId);
      if (w && this.workers.has(w.id)) { this.closeWorker(w.id); return; }
    }

    const files = post.fileIds.length ? await this.downloadAttachments(post) : [];
    if (files.length) log.debug('downloaded attachments', { post: post.id, count: files.length });
    const action = route(post, {
      getWorkerByThread: (t) => this.deps.db.getWorkerByThread(t),
      hasOpenQuestion: (wid) => this.pending.hasOpen(wid),
    });

    if (action.kind === 'supervisor') {
      log.info('route → supervisor', { post: post.id, thread: post.rootId || '(root)', files: files.length, text: preview(post.message) });
      this.pushToSupervisor(post, files);
      return;
    }
    if (action.kind === 'resolve_question') {
      log.info('route → resolve question', { worker: action.workerId, thread: post.rootId, files: files.length });
      const answer = files.length ? `${post.message}\nAttached files:\n${files.join('\n')}` : post.message;
      this.pending.resolve(action.workerId, answer);
      return;
    }
    if (action.kind === 'inject_worker') {
      const worker = this.workers.get(action.workerId);
      if (worker) {
        log.info('route → inject into worker', { worker: action.workerId, thread: post.rootId, files: files.length, text: preview(post.message) });
        worker.inject(post.message, files);
      } else {
        // DB says this thread's worker is active, but it isn't live in memory
        // (e.g. a resume that never re-attached). Don't drop the message.
        log.warn('worker not live in memory; routing to supervisor', { worker: action.workerId, thread: post.rootId });
        this.pushToSupervisor(post, files);
      }
    }
  }

  // --- alert ingestion ---

  private async handleAlert(post: IncomingPost, source: AlertSource): Promise<void> {
    const evt = parseAlert(source, post.message);
    if (!evt) { log.debug('unparseable alert (ignored)', { channel: post.channelId, source }); return; }
    log.info('alert', { source, status: evt.status, fp: evt.fingerprint, service: evt.service ?? '(none)', summary: preview(evt.summary, 80) });

    const open = this.deps.db.getOpenIncidentByFingerprint(evt.fingerprint);

    if (evt.status === 'resolved') {
      if (open && open.status === 'open') {
        this.deps.db.setIncidentStatus(open.id, 'resolved_upstream');
        void this.deps.gateway.post({ text: '✅ Alert resolved upstream. Close this thread with `/done` when you\'re satisfied.', threadRootId: open.threadRootId });
        log.info('incident resolved upstream', { incident: open.id });
      }
      return;
    }

    // firing: an existing open incident is a re-fire, not a new investigation.
    if (open) {
      this.deps.db.recordRefire(open.id);
      if (open.status === 'resolved_upstream') this.deps.db.setIncidentStatus(open.id, 'open');
      const n = this.deps.db.getIncident(open.id)?.refireCount ?? 0;
      void this.deps.gateway.post({ text: `🔁 This alert fired again (×${n}).`, threadRootId: open.threadRootId });
      log.info('incident re-fired', { incident: open.id, count: n });
      return;
    }

    // New incident → open an investigation thread in the main channel + spawn a read-only worker.
    const repoName = evt.service ? this.deps.cfg.serviceRepoMap[evt.service] : undefined;
    const repo = repoName ? this.deps.cfg.repos[repoName] : undefined;

    if (this.workers.size >= this.deps.cfg.workerConcurrency) {
      log.warn('alert not investigated — at capacity', { fp: evt.fingerprint, active: this.workers.size });
      void this.deps.gateway.post({ text: `🚨 **${preview(evt.summary, 120)}** fired, but all ${this.deps.cfg.workerConcurrency} workers are busy — not investigating yet (will retry when it fires again).` });
      return;
    }

    const threadRootId = await this.deps.gateway.post({ text: this.investigationOpening(evt, repoName) });
    const id = 'w-' + randomUUID().slice(0, 8);
    let repoPath: string;
    if (repo) {
      repoPath = repo.path;
    } else {
      repoPath = path.resolve('scratch/investigations', id);
      await mkdir(repoPath, { recursive: true });
    }
    const rec = this.deps.db.createWorker({ id, threadRootId, repoName: repoName ?? '(none)', repoPath, task: this.investigationTask(evt), kind: 'investigation' });
    this.launchWorker(rec);
    const incId = 'inc-' + randomUUID().slice(0, 8);
    this.deps.db.createIncident({ id: incId, fingerprint: evt.fingerprint, source, service: evt.service ?? null, repoName: repoName ?? null, threadRootId, workerId: id, summary: evt.summary });
    log.info('opened investigation', { incident: incId, worker: id, repo: repoName ?? '(scratch)', thread: threadRootId });
  }

  private investigationOpening(evt: AlertEvent, repoName?: string): string {
    const sev = evt.severity ? ` (${evt.severity})` : '';
    const where = repoName ? `repo **${repoName}**` : 'no mapped repo — read-only diagnosis in a scratch dir';
    const link = evt.sourceUrl ? `\n${evt.sourceUrl}` : '';
    return `🚨 **Investigating alert${sev}:** ${evt.summary}\nSource: ${evt.source} · ${where}${link}\n\nA worker is diagnosing (read-only). Reply here to steer it; \`/done\` to close.`;
  }

  private investigationTask(evt: AlertEvent): string {
    return [
      'A monitoring alert fired and you are investigating it.',
      `Source: ${evt.source}`,
      evt.service ? `Service: ${evt.service}` : '',
      evt.severity ? `Severity: ${evt.severity}` : '',
      evt.sourceUrl ? `Link: ${evt.sourceUrl}` : '',
      '',
      'Alert:',
      evt.summary,
      '',
      'Diagnose the root cause using your read-only access (kubectl, Prometheus, GlitchTip). Share findings with send_update. Propose a fix — code changes in this repository if you have one, otherwise say which repo/service it belongs in. Call finish with your diagnosis.',
    ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  }
}
