import Database from 'better-sqlite3';
import type { WorkerRecord, WorkerStatus } from './types.js';

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
    `);
  }

  private row(r: any): WorkerRecord {
    return {
      id: r.id, threadRootId: r.thread_root_id, repoName: r.repo_name, repoPath: r.repo_path,
      sessionId: r.session_id, status: r.status as WorkerStatus, task: r.task,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  createWorker(w: { id: string; threadRootId: string; repoName: string; repoPath: string; task: string }): WorkerRecord {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO workers (id, thread_root_id, repo_name, repo_path, session_id, status, task, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'running', ?, ?, ?)`
    ).run(w.id, w.threadRootId, w.repoName, w.repoPath, w.task, now, now);
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

  close(): void { this.db.close(); }
}
