import { describe, it, expect, beforeEach } from 'vitest';
import { Db } from '../src/db.js';
import { listReposHandler, spawnWorkerHandler, listWorkersHandler, type SupervisorToolDeps } from '../src/tools/supervisorTools.js';
import type { Config } from '../src/config.js';
import type { Gateway } from '../src/mattermost.js';

function fakeGateway(posts: any[]): Gateway {
  return { getBotId: () => 'bot', connect: async () => {}, post: async (a) => { posts.push(a); return 'p'; }, uploadFile: async () => 'f', downloadFile: async (_i, d) => d, close: () => {} };
}
const cfg = { repos: { acme: { path: '/repo/acme', description: 'API' } } } as unknown as Config;

let db: Db; let posts: any[]; let spawned: any[]; let deps: SupervisorToolDeps;
beforeEach(() => {
  db = new Db(':memory:'); posts = []; spawned = [];
  deps = {
    gateway: fakeGateway(posts), db, cfg,
    spawnWorker: (a) => { spawned.push(a); return { ok: true, workerId: 'w-' + spawned.length }; },
    stopWorker: () => {},
  };
});

describe('supervisor tools', () => {
  it('list_repos returns the registry', async () => {
    const res = await listReposHandler(deps, {});
    expect(res.content[0].text).toContain('acme');
    expect(res.content[0].text).toContain('/repo/acme');
  });

  it('spawn_worker with a known repo calls back and reports the worker id', async () => {
    const res = await spawnWorkerHandler(deps, { repo: 'acme', task: 'add x', threadRootId: 't1' });
    expect(spawned[0]).toEqual({ repo: 'acme', task: 'add x', threadRootId: 't1' });
    expect(res.content[0].text).toContain('w-1');
  });

  it('spawn_worker with an unknown repo returns an error result without spawning', async () => {
    const res = await spawnWorkerHandler(deps, { repo: 'ghost', task: 't', threadRootId: 't1' });
    expect(spawned).toHaveLength(0);
    expect(res.content[0].text.toLowerCase()).toContain('unknown repo');
  });

  it('list_workers reports current workers', async () => {
    db.createWorker({ id: 'w1', threadRootId: 't1', repoName: 'acme', repoPath: '/repo/acme', task: 'add x' });
    const res = await listWorkersHandler(deps, {});
    expect(res.content[0].text).toContain('w1');
    expect(res.content[0].text).toContain('running');
  });
});
