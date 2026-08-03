import { describe, it, expect, beforeEach } from 'vitest';
import { Db } from '../src/db.js';
import { PendingQuestions } from '../src/pending.js';

let db: Db; let pq: PendingQuestions;
beforeEach(() => {
  db = new Db(':memory:');
  db.createWorker({ id: 'w1', threadRootId: 't1', repoName: 'a', repoPath: '/a', task: 't' });
  pq = new PendingQuestions(db);
});

describe('PendingQuestions', () => {
  it('ask() blocks until resolve() supplies the answer', async () => {
    const p = pq.ask({ workerId: 'w1', questionPostId: 'p1' });
    expect(pq.hasOpen('w1')).toBe(true);
    const resolved = pq.resolve('w1', 'the answer');
    expect(resolved).toBe(true);
    await expect(p).resolves.toBe('the answer');
    expect(pq.hasOpen('w1')).toBe(false);
  });

  it('resolve() returns false when nothing is pending', () => {
    expect(pq.resolve('w1', 'x')).toBe(false);
  });
});
