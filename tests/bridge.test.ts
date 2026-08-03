import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Db } from '../src/db.js';
import { Bridge } from '../src/bridge.js';
import type { Config } from '../src/config.js';
import type { Gateway } from '../src/mattermost.js';
import type { IncomingPost } from '../src/types.js';

// Fake query() that records the last message pushed per session and captures a session id.
function makeQueryFn(sink: { pushed: string[] }) {
  return ((args: any) => (async function* () {
    yield { type: 'system', session_id: 'sess-' + Math.random().toString(36).slice(2, 6) };
    for await (const m of args.prompt) sink.pushed.push(m.message?.content ?? m.text);
  })()) as any;
}

function fakeGateway(posts: any[]): Gateway {
  return { getBotId: () => 'bot', connect: async () => {}, post: async (a) => { posts.push(a); return 'p' + posts.length; }, uploadFile: async () => 'f', downloadFile: async (_i, d) => d, close: () => {} };
}

const cfg = {
  repos: { acme: { path: '/repo/acme', description: 'API' } },
  ingestChannels: [], serviceRepoMap: {}, incidentCooldownMs: 3_600_000,
  workerConcurrency: 3, askUserTimeoutMs: 1000, attachmentDir: './scratch',
  mattermost: { url: '', token: '', channelId: 'c' }, dbPath: ':memory:',
} as Config;

const post = (o: Partial<IncomingPost>): IncomingPost => ({ id: 'p', channelId: 'c', rootId: '', message: 'm', userId: 'u', fileIds: [], isOwn: false, ...o });

let db: Db; let posts: any[]; let sink: { pushed: string[] }; let bridge: Bridge;
beforeEach(async () => {
  db = new Db(':memory:'); posts = []; sink = { pushed: [] };
  bridge = new Bridge({ queryFn: makeQueryFn(sink), gateway: fakeGateway(posts), db, cfg });
  await bridge.start();
});

describe('Bridge', () => {
  it('routes a top-level post to the supervisor, tagged with the thread root id', async () => {
    await bridge.handlePost(post({ id: 'root1', rootId: '', message: 'In acme add rate limiting' }));
    await vi.waitFor(() => expect(sink.pushed.some((m) => m.includes('rate limiting') && m.includes('root1'))).toBe(true));
  });

  it('spawn_worker (via bridge callback) creates and starts a worker bound to the thread', async () => {
    const res = (bridge as any).spawnWorker({ repo: 'acme', task: 'add x', threadRootId: 'root1' });
    expect(res.ok).toBe(true);
    expect(db.getWorkerByThread('root1')?.repoName).toBe('acme');
    await vi.waitFor(() => expect(sink.pushed).toContain('add x'));
  });

  it('a thread reply to a waiting worker resolves its question', async () => {
    (bridge as any).spawnWorker({ repo: 'acme', task: 'add x', threadRootId: 'root1' });
    const w = db.getWorkerByThread('root1')!;
    db.updateWorker(w.id, { status: 'waiting' });
    db.addPendingQuestion({ id: 'q1', workerId: w.id, questionPostId: 'qp' });
    const p = (bridge as any).pending.ask({ workerId: w.id, questionPostId: 'qp2' }); // arm an in-memory resolver
    await bridge.handlePost(post({ id: 'r', rootId: 'root1', message: 'go ahead' }));
    await expect(p).resolves.toContain('go ahead');
  });

  it('enforces the concurrency cap', () => {
    const small = new Bridge({ queryFn: makeQueryFn(sink), gateway: fakeGateway(posts), db: new Db(':memory:'), cfg: { ...cfg, workerConcurrency: 1 } });
    const a = (small as any).spawnWorker({ repo: 'acme', task: 'a', threadRootId: 't1' });
    const b = (small as any).spawnWorker({ repo: 'acme', task: 'b', threadRootId: 't2' });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
  });

  it('on restart, clears a stale open question, notifies the operator, and routes a later reply to the resumed worker', async () => {
    // Seed a persisted worker that was mid-ask_user (waiting, with a session id) plus an open question.
    const db2 = new Db(':memory:');
    const rec = db2.createWorker({ id: 'w-seed', threadRootId: 'root-seed', repoName: 'acme', repoPath: '/repo/acme', task: 'seeded task' });
    db2.updateWorker(rec.id, { sessionId: 'sess-old', status: 'waiting' });
    db2.addPendingQuestion({ id: 'q-open', workerId: rec.id, questionPostId: 'qp-open' });
    expect(db2.getOpenQuestionForWorker(rec.id)).toBeTruthy();

    const posts2: any[] = [];
    const sink2 = { pushed: [] as string[] };
    const bridge2 = new Bridge({ queryFn: makeQueryFn(sink2), gateway: fakeGateway(posts2), db: db2, cfg });
    await bridge2.start();

    // (a) open question cleared
    expect(db2.getOpenQuestionForWorker(rec.id)).toBeUndefined();
    // (b) a restart note was posted to the worker's thread
    expect(posts2.some((p) => p.threadRootId === 'root-seed' && /restarted/i.test(p.text))).toBe(true);

    // (c) a later reply in that thread is injected into the resumed worker (not swallowed)
    await bridge2.handlePost(post({ id: 'reply1', rootId: 'root-seed', message: 'here is my answer' }));
    await vi.waitFor(() => expect(sink2.pushed).toContain('here is my answer'));
  });

  it('operator /done closes the worker and tears down the session (prompt stream closes)', async () => {
    // queryFn that records when its input loop ends (i.e. the prompt stream was closed).
    const streamEnded: string[] = [];
    const queryFn = ((args: any) => (async function* () {
      yield { type: 'system', session_id: 'sess-done' };
      for await (const _m of args.prompt) { /* drain */ }
      streamEnded.push('ended');
    })()) as any;

    const posts3: any[] = [];
    const db3 = new Db(':memory:');
    const bridge3 = new Bridge({ queryFn, gateway: fakeGateway(posts3), db: db3, cfg });
    await bridge3.start();

    const res = (bridge3 as any).spawnWorker({ repo: 'acme', task: 'do it', threadRootId: 'root-fin' });
    expect(res.ok).toBe(true);
    const id = res.workerId;
    expect((bridge3 as any).workers.has(id)).toBe(true);

    // Operator types /done in the thread -> the worker is closed.
    await bridge3.handlePost(post({ id: 'd1', rootId: 'root-fin', message: '/done' }));

    expect((bridge3 as any).workers.has(id)).toBe(false);
    expect(db3.getWorker(id)!.status).toBe('finished');
    expect(posts3.some((p) => p.threadRootId === 'root-fin' && /closed/i.test(p.text))).toBe(true);
    // The deferred stop() actually closed the prompt stream (loop ended).
    await vi.waitFor(() => expect(streamEnded).toContain('ended'));
  });
});
