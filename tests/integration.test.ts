import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Db } from '../src/db.js';
import { Bridge } from '../src/bridge.js';
import { askUserHandler, sendUpdateHandler, finishHandler } from '../src/tools/workerTools.js';
import type { Config } from '../src/config.js';
import type { Gateway } from '../src/mattermost.js';
import type { IncomingPost } from '../src/types.js';

function fakeGateway(posts: any[], uploads: string[]): Gateway {
  return {
    getBotId: () => 'bot', connect: async () => {},
    post: async (a) => { posts.push(a); return 'p' + posts.length; },
    uploadFile: async (f) => { uploads.push(f); return 'file-' + uploads.length; },
    downloadFile: async (_i, d) => d,
    addReaction: async () => {}, removeReaction: async () => {},
    close: () => {},
  };
}
const queryFn = ((args: any) => (async function* () {
  yield { type: 'system', session_id: 's' };
  for await (const _m of args.prompt) { /* drain */ }
})()) as any;

const cfg = {
  repos: { acme: { path: process.cwd(), description: 'API' } },
  ingestChannels: [], serviceRepoMap: {}, incidentCooldownMs: 3_600_000,
  workerConcurrency: 3, askUserTimeoutMs: 1000, attachmentDir: './scratch',
  mattermost: { url: '', token: '', channelId: 'c' }, dbPath: ':memory:',
} as Config;
const post = (o: Partial<IncomingPost>): IncomingPost => ({ id: 'p', channelId: 'c', rootId: '', message: 'm', userId: 'u', fileIds: [], isOwn: false, ...o });

let db: Db; let posts: any[]; let uploads: string[]; let bridge: Bridge;
beforeEach(async () => {
  db = new Db(':memory:'); posts = []; uploads = [];
  bridge = new Bridge({ queryFn, gateway: fakeGateway(posts, uploads), db, cfg });
  await bridge.start();
});

describe('end-to-end feature flow', () => {
  it('spawn -> ask_user -> operator reply -> send_update(file) -> finish', async () => {
    // 1. Operator posts a feature request (top-level) -> supervisor (routed).
    await bridge.handlePost(post({ id: 'root1', rootId: '', message: 'In acme add a note' }));

    // 2. Supervisor decides to spawn (simulate its spawn_worker tool callback).
    const spawn = (bridge as any).spawnWorker({ repo: 'acme', task: 'add a note', threadRootId: 'root1' });
    expect(spawn.ok).toBe(true);
    const worker = db.getWorkerByThread('root1')!;
    const pending = (bridge as any).pending;
    const deps = { gateway: (bridge as any).deps.gateway, db, pending, workerId: worker.id, threadRootId: 'root1' };

    // 3. Worker asks a question (blocks).
    const asked = askUserHandler(deps, { question: 'Which file?' });
    await vi.waitFor(() => expect(posts.some((p) => p.text === 'Which file?')).toBe(true));
    expect(db.getWorker(worker.id)!.status).toBe('waiting');

    // 4. Operator replies in the thread -> resolves the question.
    await bridge.handlePost(post({ id: 'r1', rootId: 'root1', message: 'README.md' }));
    await expect(asked).resolves.toMatchObject({ content: [{ text: expect.stringContaining('README.md') }] });
    expect(db.getWorker(worker.id)!.status).toBe('running');

    // 5. Worker sends an artifact, then PROPOSES completion (does not self-close).
    await sendUpdateHandler(deps, { text: 'Here is the diff', files: ['/scratch/change.diff'] });
    expect(uploads).toContain('/scratch/change.diff');
    await finishHandler(deps, { summary: 'Done: added the note.' });
    expect(posts.some((p) => p.text.includes('Done: added the note.') && p.text.includes('/done'))).toBe(true);
    expect(db.getWorker(worker.id)!.status).toBe('running'); // not finished — awaiting the operator

    // 6. Operator closes the thread with /done -> worker torn down, marked finished.
    await bridge.handlePost(post({ id: 'done1', rootId: 'root1', message: '/done' }));
    expect(db.getWorker(worker.id)!.status).toBe('finished');
    expect(posts.some((p) => /closed/i.test(p.text))).toBe(true);
  });
});
