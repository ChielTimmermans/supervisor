import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Db } from '../src/db.js';
import { PendingQuestions } from '../src/pending.js';
import { askUserHandler, sendUpdateHandler, finishHandler, type WorkerToolDeps } from '../src/tools/workerTools.js';
import type { Gateway } from '../src/mattermost.js';

function fakeGateway(): Gateway & { posts: any[]; uploads: string[] } {
  const posts: any[] = []; const uploads: string[] = [];
  return {
    posts, uploads,
    getBotId: () => 'bot',
    connect: async () => {},
    post: async (a) => { posts.push(a); return 'post-' + posts.length; },
    uploadFile: async (p) => { uploads.push(p); return 'file-' + uploads.length; },
    downloadFile: async (_id, dest) => dest,
    close: () => {},
  };
}

let db: Db; let pending: PendingQuestions; let gateway: ReturnType<typeof fakeGateway>; let deps: WorkerToolDeps; let finished: boolean;
beforeEach(() => {
  db = new Db(':memory:');
  db.createWorker({ id: 'w1', threadRootId: 't1', repoName: 'a', repoPath: '/a', task: 't' });
  pending = new PendingQuestions(db);
  gateway = fakeGateway();
  finished = false;
  deps = { gateway, db, pending, workerId: 'w1', threadRootId: 't1', onFinish: () => { finished = true; } };
});

describe('worker tools', () => {
  it('ask_user posts the question, marks waiting, and blocks until answered', async () => {
    const p = askUserHandler(deps, { question: 'proceed?' });
    await vi.waitFor(() => expect(gateway.posts[0]).toMatchObject({ text: 'proceed?', threadRootId: 't1' }));
    expect(db.getWorker('w1')!.status).toBe('waiting');
    pending.resolve('w1', 'yes');
    const result = await p;
    expect(result.content[0].text).toContain('yes');
    expect(db.getWorker('w1')!.status).toBe('running');
  });

  it('send_update uploads files and posts with file ids', async () => {
    const res = await sendUpdateHandler(deps, { text: 'here is the plan', files: ['/tmp/plan.md'] });
    expect(gateway.uploads).toEqual(['/tmp/plan.md']);
    expect(gateway.posts[0]).toMatchObject({ text: 'here is the plan', threadRootId: 't1', fileIds: ['file-1'] });
    expect(res.content[0].text).toBeDefined();
  });

  it('finish posts the summary, marks finished, and calls onFinish', async () => {
    await finishHandler(deps, { summary: 'done' });
    expect(gateway.posts[0]).toMatchObject({ text: 'done', threadRootId: 't1' });
    expect(db.getWorker('w1')!.status).toBe('finished');
    expect(finished).toBe(true);
  });
});
