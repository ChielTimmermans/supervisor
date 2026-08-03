import Database from 'better-sqlite3';
import type { WorkerRecord, WorkerStatus, WorkerKind, IncidentRecord, IncidentStatus, AlertSource } from './types.js';

export class Db {
  private db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workers (
        id TEXT PRIMARY KEY,
        thread_root_id TEXT NOT NULL,
        repo_name TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'feature',
        task TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workers_thread ON workers(thread_root_id);
      CREATE TABLE IF NOT EXISTS pending_questions (
        id TEXT PRIMARY KEY,
        worker_id TEXT NOT NULL,
        question_post_id TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0,
        answer TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pq_worker ON pending_questions(worker_id, resolved);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        source TEXT NOT NULL,
        service TEXT,
        repo_name TEXT,
        thread_root_id TEXT NOT NULL,
        worker_id TEXT,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        refire_count INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_incidents_fp ON incidents(fingerprint, status);
      CREATE INDEX IF NOT EXISTS idx_incidents_thread ON incidents(thread_root_id);
    `);
    // Migration: add workers.kind to databases created before it existed.
    const cols = this.db.prepare(`PRAGMA table_info(workers)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'kind')) {
      this.db.exec(`ALTER TABLE workers ADD COLUMN kind TEXT NOT NULL DEFAULT 'feature'`);
    }
  }

  private row(r: any): WorkerRecord {
    return {
      id: r.id, threadRootId: r.thread_root_id, repoName: r.repo_name, repoPath: r.repo_path,
      sessionId: r.session_id, status: r.status as WorkerStatus, kind: (r.kind ?? 'feature') as WorkerKind,
      task: r.task, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  createWorker(w: { id: string; threadRootId: string; repoName: string; repoPath: string; task: string; kind?: WorkerKind }): WorkerRecord {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO workers (id, thread_root_id, repo_name, repo_path, session_id, status, kind, task, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'running', ?, ?, ?, ?)`
    ).run(w.id, w.threadRootId, w.repoName, w.repoPath, w.kind ?? 'feature', w.task, now, now);
    return this.getWorker(w.id)!;
  }

  getWorker(id: string): WorkerRecord | undefined {
    const r = this.db.prepare(`SELECT * FROM workers WHERE id = ?`).get(id);
    return r ? this.row(r) : undefined;
  }

  getWorkerByThread(threadRootId: string): WorkerRecord | undefined {
    const r = this.db.prepare(`SELECT * FROM workers WHERE thread_root_id = ? ORDER BY created_at DESC LIMIT 1`).get(threadRootId);
    return r ? this.row(r) : undefined;
  }

  listWorkers(): WorkerRecord[] {
    return this.db.prepare(`SELECT * FROM workers ORDER BY created_at`).all().map((r) => this.row(r));
  }

  updateWorker(id: string, patch: Partial<Pick<WorkerRecord, 'sessionId' | 'status'>>): void {
    const cur = this.getWorker(id);
    if (!cur) return;
    const sessionId = patch.sessionId !== undefined ? patch.sessionId : cur.sessionId;
    const status = patch.status !== undefined ? patch.status : cur.status;
    this.db.prepare(`UPDATE workers SET session_id = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(sessionId, status, Date.now(), id);
  }

  addPendingQuestion(q: { id: string; workerId: string; questionPostId: string }): void {
    this.db.prepare(
      `INSERT INTO pending_questions (id, worker_id, question_post_id, resolved, created_at) VALUES (?, ?, ?, 0, ?)`
    ).run(q.id, q.workerId, q.questionPostId, Date.now());
  }

  resolvePendingQuestion(id: string, answer: string): void {
    this.db.prepare(`UPDATE pending_questions SET resolved = 1, answer = ? WHERE id = ?`).run(answer, id);
  }

  getOpenQuestionForWorker(workerId: string): { id: string; questionPostId: string } | undefined {
    const r = this.db.prepare(
      `SELECT id, question_post_id FROM pending_questions WHERE worker_id = ? AND resolved = 0 ORDER BY created_at DESC LIMIT 1`
    ).get(workerId) as any;
    return r ? { id: r.id, questionPostId: r.question_post_id } : undefined;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }
  getMeta(key: string): string | undefined {
    const r = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as any;
    return r?.value;
  }

  // --- incidents ---

  private incidentRow(r: any): IncidentRecord {
    return {
      id: r.id, fingerprint: r.fingerprint, source: r.source as AlertSource,
      service: r.service, repoName: r.repo_name, threadRootId: r.thread_root_id,
      workerId: r.worker_id, status: r.status as IncidentStatus, summary: r.summary,
      createdAt: r.created_at, lastSeenAt: r.last_seen_at, refireCount: r.refire_count,
    };
  }

  createIncident(i: {
    id: string; fingerprint: string; source: AlertSource; service: string | null;
    repoName: string | null; threadRootId: string; workerId: string | null; summary: string;
  }): IncidentRecord {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO incidents (id, fingerprint, source, service, repo_name, thread_root_id, worker_id, status, summary, created_at, last_seen_at, refire_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, 1)`
    ).run(i.id, i.fingerprint, i.source, i.service, i.repoName, i.threadRootId, i.workerId, i.summary, now, now);
    return this.getIncident(i.id)!;
  }

  getIncident(id: string): IncidentRecord | undefined {
    const r = this.db.prepare(`SELECT * FROM incidents WHERE id = ?`).get(id);
    return r ? this.incidentRow(r) : undefined;
  }

  getOpenIncidentByFingerprint(fingerprint: string): IncidentRecord | undefined {
    const r = this.db.prepare(
      `SELECT * FROM incidents WHERE fingerprint = ? AND status != 'closed' ORDER BY created_at DESC LIMIT 1`
    ).get(fingerprint);
    return r ? this.incidentRow(r) : undefined;
  }

  getIncidentByThread(threadRootId: string): IncidentRecord | undefined {
    const r = this.db.prepare(
      `SELECT * FROM incidents WHERE thread_root_id = ? ORDER BY created_at DESC LIMIT 1`
    ).get(threadRootId);
    return r ? this.incidentRow(r) : undefined;
  }

  listOpenIncidents(): IncidentRecord[] {
    return this.db.prepare(`SELECT * FROM incidents WHERE status != 'closed' ORDER BY created_at`).all().map((r) => this.incidentRow(r));
  }

  recordRefire(id: string): void {
    this.db.prepare(`UPDATE incidents SET last_seen_at = ?, refire_count = refire_count + 1 WHERE id = ?`).run(Date.now(), id);
  }

  setIncidentStatus(id: string, status: IncidentStatus): void {
    this.db.prepare(`UPDATE incidents SET status = ?, last_seen_at = ? WHERE id = ?`).run(status, Date.now(), id);
  }

  close(): void { this.db.close(); }
}
