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

function fakeGateway(posts: any[], reactions: [string, string][] = []): Gateway {
  return { getBotId: () => 'bot', connect: async () => {}, post: async (a) => { posts.push(a); return 'p' + posts.length; }, uploadFile: async () => 'f', downloadFile: async (_i, d) => d, addReaction: async (postId, emoji) => { reactions.push([postId, emoji]); }, removeReaction: async () => {}, close: () => {} };
}

const cfg = {
  repos: { acme: { path: '/repo/acme', description: 'API' } },
  ingestChannels: [], serviceRepoMap: {}, incidentCooldownMs: 3_600_000,
  workerConcurrency: 3, investigationConcurrency: 2, askUserTimeoutMs: 1000, attachmentDir: './scratch',
  mattermost: { url: '', token: '', channelId: 'c' }, dbPath: ':memory:',
} as Config;

const post = (o: Partial<IncomingPost>): IncomingPost => ({ id: 'p', channelId: 'c', rootId: '', message: 'm', userId: 'u', fileIds: [], isOwn: false, ...o });

let db: Db; let posts: any[]; let reactions: [string, string][]; let sink: { pushed: string[] }; let bridge: Bridge;
beforeEach(async () => {
  db = new Db(':memory:'); posts = []; reactions = []; sink = { pushed: [] };
  bridge = new Bridge({ queryFn: makeQueryFn(sink), gateway: fakeGateway(posts, reactions), db, cfg });
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
    await vi.waitFor(() => expect(reactions).toContainEqual(['root1', 'hourglass_flowing_sand']));
  });

  it('marks a worker thread failed with the ❌ reaction', async () => {
    const res = (bridge as any).spawnWorker({ repo: 'acme', task: 'add x', threadRootId: 'root-fail' });
    (bridge as any).markFailed(res.workerId, 'boom');
    await vi.waitFor(() => expect(reactions).toContainEqual(['root-fail', 'x']));
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

  it('handles a post whose attachment download fails, without dropping the message', async () => {
    const db4 = new Db(':memory:');
    const s4 = { pushed: [] as string[] };
    const gw: Gateway = { ...fakeGateway([]), downloadFile: async () => { throw new Error('fetch failed'); } };
    const b4 = new Bridge({ queryFn: makeQueryFn(s4), gateway: gw, db: db4, cfg });
    await b4.start();

    await expect(
      b4.handlePost(post({ id: 'root9', rootId: '', message: 'look at this file', fileIds: ['f1'] })),
    ).resolves.toBeUndefined();
    await vi.waitFor(() => expect(s4.pushed.some((m) => m.includes('look at this file'))).toBe(true));
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

    const posts3: any[] = []; const reactions3: [string, string][] = [];
    const db3 = new Db(':memory:');
    const bridge3 = new Bridge({ queryFn, gateway: fakeGateway(posts3, reactions3), db: db3, cfg });
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
    await vi.waitFor(() => expect(reactions3).toContainEqual(['root-fin', 'white_check_mark']));
    // The deferred stop() actually closed the prompt stream (loop ended).
    await vi.waitFor(() => expect(streamEnded).toContain('ended'));
  });

  function ingestBridge(posts: any[], sink: { pushed: string[] }, db: Db) {
    const c = { ...cfg, ingestChannels: [{ channelId: 'c-infra', source: 'prometheus' as const }] } as Config;
    return new Bridge({ queryFn: makeQueryFn(sink), gateway: fakeGateway(posts), db, cfg: c });
  }
  function ingestBridgeCap(posts: any[], sink: { pushed: string[] }, db: Db, invCap: number) {
    const c = { ...cfg, ingestChannels: [{ channelId: 'c-infra', source: 'prometheus' as const }], investigationConcurrency: invCap } as Config;
    return new Bridge({ queryFn: makeQueryFn(sink), gateway: fakeGateway(posts), db, cfg: c });
  }
  const fire = (msg: string) => post({ channelId: 'c-infra', rootId: '', message: msg });

  it('an ingest-channel alert opens an investigation and records an incident', async () => {
    const p: any[] = []; const s = { pushed: [] as string[] }; const d = new Db(':memory:');
    const b = ingestBridge(p, s, d); await b.start();
    await b.handlePost(fire(':red_circle: [FIRING] KubeProxyDown\nTarget disappeared from discovery.'));

    const inc = d.getOpenIncidentByFingerprint('prometheus:KubeProxyDown');
    expect(inc).toBeTruthy();
    expect(inc!.workerId).toBeTruthy();
    // opening message posted to the main channel (no thread root)
    expect(p.some((x) => /Investigating/i.test(x.text) && !x.threadRootId)).toBe(true);
    // the investigation worker got the alert as its task
    await vi.waitFor(() => expect(s.pushed.some((m) => m.includes('KubeProxyDown'))).toBe(true));
    expect(d.listWorkers()[0].kind).toBe('investigation');
  });

  it('a re-fire of the same alert does not open a second investigation', async () => {
    const p: any[] = []; const s = { pushed: [] as string[] }; const d = new Db(':memory:');
    const b = ingestBridge(p, s, d); await b.start();
    await b.handlePost(fire(':red_circle: [FIRING] KubeProxyDown\nx'));
    await b.handlePost(fire(':red_circle: [FIRING] KubeProxyDown\nx'));

    expect(d.getOpenIncidentByFingerprint('prometheus:KubeProxyDown')!.refireCount).toBe(2);
    expect(d.listWorkers().filter((w) => w.kind === 'investigation').length).toBe(1);
    expect(p.some((x) => /fired again/i.test(x.text))).toBe(true);
  });

  it('a resolved alert marks the incident resolved_upstream', async () => {
    const p: any[] = []; const s = { pushed: [] as string[] }; const d = new Db(':memory:');
    const b = ingestBridge(p, s, d); await b.start();
    await b.handlePost(fire(':red_circle: [FIRING] DiskFull\nx'));
    await b.handlePost(fire(':large_green_circle: [RESOLVED] DiskFull\nx'));

    expect(d.getOpenIncidentByFingerprint('prometheus:DiskFull')!.status).toBe('resolved_upstream');
    expect(p.some((x) => /resolved upstream/i.test(x.text))).toBe(true);
  });

  it('/done on an investigation thread closes both the worker and the incident', async () => {
    const p: any[] = []; const s = { pushed: [] as string[] }; const d = new Db(':memory:');
    const b = ingestBridge(p, s, d); await b.start();
    await b.handlePost(fire(':red_circle: [FIRING] OOMKilled\nx'));
    const inc = d.getOpenIncidentByFingerprint('prometheus:OOMKilled')!;

    // Operator closes in the main channel thread (not an ingest channel).
    await b.handlePost(post({ id: 'done', channelId: 'c', rootId: inc.threadRootId, message: '/done' }));
    expect(d.getIncident(inc.id)!.status).toBe('closed');
    expect(d.getWorker(inc.workerId!)!.status).toBe('finished');
  });

  it('queues a new investigation when the investigation pool is full, without dropping it', async () => {
    const p: any[] = []; const s = { pushed: [] as string[] }; const d = new Db(':memory:');
    const b = ingestBridgeCap(p, s, d, 1); await b.start();
    await b.handlePost(fire(':red_circle: [FIRING] AlertA\nx'));
    await b.handlePost(fire(':red_circle: [FIRING] AlertB\nx'));

    expect(d.listWorkers().filter((w) => w.kind === 'investigation').length).toBe(1);
    const incB = d.getOpenIncidentByFingerprint('prometheus:AlertB')!;
    expect(incB.status).toBe('queued');
    expect(incB.workerId).toBeNull();
    expect(p.some((x) => /queued/i.test(x.text))).toBe(true);

    // Feature pool is independent — a feature worker still spawns despite the full investigation pool.
    expect((b as any).spawnWorker({ repo: 'acme', task: 'f', threadRootId: 'root-feat' }).ok).toBe(true);
  });

  it('drains a queued investigation when an investigation slot frees', async () => {
    const p: any[] = []; const s = { pushed: [] as string[] }; const d = new Db(':memory:');
    const b = ingestBridgeCap(p, s, d, 1); await b.start();
    await b.handlePost(fire(':red_circle: [FIRING] AlertA\nx'));
    await b.handlePost(fire(':red_circle: [FIRING] AlertB\nx'));
    const incA = d.getOpenIncidentByFingerprint('prometheus:AlertA')!;

    await b.handlePost(post({ id: 'doneA', channelId: 'c', rootId: incA.threadRootId, message: '/done' }));

    await vi.waitFor(() => {
      const incB = d.getOpenIncidentByFingerprint('prometheus:AlertB')!;
      expect(incB.status).toBe('open');
      expect(incB.workerId).toBeTruthy();
    });
  });

  it('/done on a queued thread closes it and it never drains', async () => {
    const p: any[] = []; const s = { pushed: [] as string[] }; const d = new Db(':memory:');
    const b = ingestBridgeCap(p, s, d, 1); await b.start();
    await b.handlePost(fire(':red_circle: [FIRING] AlertA\nx'));
    await b.handlePost(fire(':red_circle: [FIRING] AlertB\nx'));
    const incB = d.getOpenIncidentByFingerprint('prometheus:AlertB')!;

    await b.handlePost(post({ id: 'doneB', channelId: 'c', rootId: incB.threadRootId, message: '/done' }));
    expect(d.getIncident(incB.id)!.status).toBe('closed');

    // Freeing A's slot must not resurrect the closed, de-queued incident.
    const incA = d.getOpenIncidentByFingerprint('prometheus:AlertA')!;
    await b.handlePost(post({ id: 'doneA', channelId: 'c', rootId: incA.threadRootId, message: '/done' }));
    await new Promise((r) => setImmediate(r));
    expect(d.getIncident(incB.id)!.status).toBe('closed');
    expect(d.getIncident(incB.id)!.workerId).toBeNull();
  });

  it('/done closes a thread even when the worker is not live in memory', async () => {
    const res = (bridge as any).spawnWorker({ repo: 'acme', task: 't', threadRootId: 'root-dead' });
    (bridge as any).workers.delete(res.workerId); // simulate a worker that didn't re-attach
    await bridge.handlePost(post({ id: 'dd', rootId: 'root-dead', message: '/done' }));
    expect(db.getWorker(res.workerId)!.status).toBe('finished');
  });

  it('re-enqueues queued incidents on restart and drains them', async () => {
    const d = new Db(':memory:');
    d.createIncident({
      id: 'iq', fingerprint: 'prometheus:Seed', source: 'prometheus', service: null,
      repoName: null, threadRootId: 'root-q', workerId: null, summary: 'seed alert', status: 'queued',
    });
    const p: any[] = []; const s = { pushed: [] as string[] };
    const b = ingestBridgeCap(p, s, d, 2); await b.start();

    await vi.waitFor(() => {
      const inc = d.getIncident('iq')!;
      expect(inc.status).toBe('open');
      expect(inc.workerId).toBeTruthy();
    });
  });
});
