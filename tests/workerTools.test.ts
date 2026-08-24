import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Db } from '../src/db.js';
import { PendingQuestions } from '../src/pending.js';
import { DevEnvLocks } from '../src/devEnvLocks.js';
import { askUserHandler, sendUpdateHandler, finishHandler, claimDevHandler, releaseDevHandler, createWorkerToolServer, type WorkerToolDeps } from '../src/tools/workerTools.js';
import type { Gateway } from '../src/mattermost.js';

function fakeGateway(): Gateway & { posts: any[]; uploads: string[]; reactions: [string, string][] } {
  const posts: any[] = []; const uploads: string[] = []; const reactions: [string, string][] = [];
  return {
    posts, uploads, reactions,
    getBotId: () => 'bot',
    connect: async () => {},
    post: async (a) => { posts.push(a); return 'post-' + posts.length; },
    uploadFile: async (p) => { uploads.push(p); return 'file-' + uploads.length; },
    downloadFile: async (_id, dest) => dest,
    addReaction: async (postId, emoji) => { reactions.push([postId, emoji]); },
    removeReaction: async () => {},
    close: () => {},
  };
}

let db: Db; let pending: PendingQuestions; let gateway: ReturnType<typeof fakeGateway>; let devLocks: DevEnvLocks; let deps: WorkerToolDeps;
beforeEach(() => {
  db = new Db(':memory:');
  db.createWorker({ id: 'w1', threadRootId: 't1', repoName: 'a', repoPath: '/a', task: 't' });
  pending = new PendingQuestions(db);
  gateway = fakeGateway();
  devLocks = new DevEnvLocks(db, { ttlMs: 100_000, waitTimeoutMs: 100_000 });
  deps = { gateway, db, pending, workerId: 'w1', threadRootId: 't1', repoName: 'a', kind: 'feature', devLocks };
});

describe('worker tools', () => {
  it('ask_user posts the question, marks waiting, and blocks until answered', async () => {
    const p = askUserHandler(deps, { question: 'proceed?' });
    await vi.waitFor(() => expect(gateway.posts[0]).toMatchObject({ text: 'proceed?', threadRootId: 't1' }));
    expect(db.getWorker('w1')!.status).toBe('waiting');
    await vi.waitFor(() => expect(gateway.reactions).toContainEqual(['t1', 'raised_hand']));
    pending.resolve('w1', 'yes');
    const result = await p;
    expect(result.content[0].text).toContain('yes');
    expect(db.getWorker('w1')!.status).toBe('running');
    await vi.waitFor(() => expect(gateway.reactions).toContainEqual(['t1', 'hourglass_flowing_sand']));
  });

  it('send_update uploads files and posts with file ids', async () => {
    const res = await sendUpdateHandler(deps, { text: 'here is the plan', files: ['/tmp/plan.md'] });
    expect(gateway.uploads).toEqual(['/tmp/plan.md']);
    expect(gateway.posts[0]).toMatchObject({ text: 'here is the plan', threadRootId: 't1', fileIds: ['file-1'] });
    expect(res.content[0].text).toBeDefined();
  });

  it('finish posts a completion proposal (with /done hint) and does NOT close the worker', async () => {
    const res = await finishHandler(deps, { summary: 'the feature works now' });
    expect(gateway.posts[0].threadRootId).toBe('t1');
    expect(gateway.posts[0].text).toContain('the feature works now');
    expect(gateway.posts[0].text).toContain('/done');
    // finish no longer marks the worker finished — completion is the operator's call.
    expect(db.getWorker('w1')!.status).toBe('running');
    await vi.waitFor(() => expect(gateway.reactions).toContainEqual(['t1', 'checkered_flag']));
    expect(res.content[0].text).toBeDefined();
  });
});

describe('dev-env claim tools', () => {
  it('feature workers get claim_dev/release_dev; investigation workers do not', () => {
    const feat = createWorkerToolServer(deps).toolNames;
    expect(feat).toContain('mcp__worker__claim_dev');
    expect(feat).toContain('mcp__worker__release_dev');
    const inv = createWorkerToolServer({ ...deps, kind: 'investigation' }).toolNames;
    expect(inv).not.toContain('mcp__worker__claim_dev');
    expect(inv).not.toContain('mcp__worker__release_dev');
  });

  it('claim_dev grants a free env immediately and release_dev frees it', async () => {
    const granted = await claimDevHandler(deps, {});
    expect(granted.content[0].text).toContain('now hold');
    expect(devLocks.holderOf('a')?.workerId).toBe('w1');

    const released = await releaseDevHandler(deps, {});
    expect(released.content[0].text).toContain('Released');
    expect(devLocks.holderOf('a')).toBeUndefined();
  });

  it('release_dev on an env you do not hold is a friendly no-op', async () => {
    const res = await releaseDevHandler(deps, {});
    expect(res.content[0].text).toContain("don't currently hold");
  });

  it('claim_dev blocks when busy, notifies the operator, then resolves when the env frees', async () => {
    devLocks.claim('a', 'w1', 't1'); // w1 holds it

    // w2 wants the same repo
    db.createWorker({ id: 'w2', threadRootId: 't2', repoName: 'a', repoPath: '/a', task: 't2' });
    const g2 = fakeGateway();
    const deps2: WorkerToolDeps = { gateway: g2, db, pending, workerId: 'w2', threadRootId: 't2', repoName: 'a', kind: 'feature', devLocks };

    const pending2 = claimDevHandler(deps2, {});
    await vi.waitFor(() => expect(g2.posts[0]?.text).toContain('Waiting for'));
    expect(db.getWorker('w2')!.status).toBe('waiting');

    // holder releases → w2 is promoted and its handler returns
    devLocks.release('a', 'w1');
    const res = await pending2;
    expect(res.content[0].text).toContain('now yours');
    expect(g2.posts.some((p) => p.text.includes('is free'))).toBe(true);
    expect(db.getWorker('w2')!.status).toBe('running');
    expect(devLocks.holderOf('a')?.workerId).toBe('w2');
  });
});
