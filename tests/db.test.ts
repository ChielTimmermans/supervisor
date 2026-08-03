import { describe, it, expect, beforeEach } from 'vitest';
import { Db } from '../src/db.js';

let db: Db;
beforeEach(() => { db = new Db(':memory:'); });

describe('Db', () => {
  it('creates and reads a worker by id and thread', () => {
    const w = db.createWorker({ id: 'w1', threadRootId: 't1', repoName: 'acme', repoPath: '/r/acme', task: 'do x' });
    expect(w.status).toBe('running');
    expect(db.getWorker('w1')?.task).toBe('do x');
    expect(db.getWorkerByThread('t1')?.id).toBe('w1');
  });

  it('updates session id and status', () => {
    db.createWorker({ id: 'w1', threadRootId: 't1', repoName: 'a', repoPath: '/a', task: 't' });
    db.updateWorker('w1', { sessionId: 's1', status: 'waiting' });
    const w = db.getWorker('w1')!;
    expect(w.sessionId).toBe('s1');
    expect(w.status).toBe('waiting');
  });

  it('tracks pending questions per worker', () => {
    db.createWorker({ id: 'w1', threadRootId: 't1', repoName: 'a', repoPath: '/a', task: 't' });
    db.addPendingQuestion({ id: 'q1', workerId: 'w1', questionPostId: 'p1' });
    expect(db.getOpenQuestionForWorker('w1')?.id).toBe('q1');
    db.resolvePendingQuestion('q1', 'the answer');
    expect(db.getOpenQuestionForWorker('w1')).toBeUndefined();
  });

  it('stores meta key/values', () => {
    db.setMeta('supervisor_session', 's-123');
    expect(db.getMeta('supervisor_session')).toBe('s-123');
  });
});
