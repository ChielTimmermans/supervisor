import { describe, it, expect } from 'vitest';
import { route, type RouterState } from '../src/router.js';
import type { IncomingPost, WorkerRecord } from '../src/types.js';

const post = (over: Partial<IncomingPost>): IncomingPost => ({
  id: 'p', channelId: 'c', rootId: '', message: 'm', userId: 'u', fileIds: [], isOwn: false, ...over,
});
const worker = (over: Partial<WorkerRecord>): WorkerRecord => ({
  id: 'w1', threadRootId: 't1', repoName: 'a', repoPath: '/a', sessionId: 's', status: 'running',
  task: 't', createdAt: 0, updatedAt: 0, ...over,
});

function state(worker: WorkerRecord | undefined, openQ: boolean): RouterState {
  return { getWorkerByThread: () => worker, hasOpenQuestion: () => openQ };
}

describe('route', () => {
  it('top-level post goes to supervisor', () => {
    expect(route(post({ rootId: '' }), state(undefined, false))).toEqual({ kind: 'supervisor' });
  });
  it('thread reply to a waiting worker resolves the question', () => {
    expect(route(post({ rootId: 't1' }), state(worker({}), true)))
      .toEqual({ kind: 'resolve_question', workerId: 'w1' });
  });
  it('thread reply to a running worker with no open question injects', () => {
    expect(route(post({ rootId: 't1' }), state(worker({}), false)))
      .toEqual({ kind: 'inject_worker', workerId: 'w1' });
  });
  it('thread reply with no worker goes to supervisor', () => {
    expect(route(post({ rootId: 'tX' }), state(undefined, false))).toEqual({ kind: 'supervisor' });
  });
});
