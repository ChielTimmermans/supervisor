import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Db } from '../src/db.js';
import { PendingQuestions } from '../src/pending.js';
import { Worker } from '../src/worker.js';
import type { Config } from '../src/config.js';
import type { Gateway } from '../src/mattermost.js';

function fakeGateway(): Gateway {
  return { getBotId: () => 'bot', connect: async () => {}, post: async () => 'p', uploadFile: async () => 'f', downloadFile: async (_i, d) => d, close: () => {} };
}
const cfg = { attachmentDir: './scratch', askUserTimeoutMs: 1000, repos: {}, mattermost: { url: '', token: '', channelId: '' }, workerConcurrency: 1, dbPath: ':memory:' } as Config;

let db: Db;
beforeEach(() => { db = new Db(':memory:'); });

describe('Worker', () => {
  it('starts a session in the repo cwd with worker tools and the task as first message', async () => {
    const seenOptions: any[] = []; const received: string[] = [];
    const queryFn = ((args: any) => (async function* () {
      seenOptions.push(args.options);
      yield { type: 'system', subtype: 'init', session_id: 'ws-1' };
      for await (const m of args.prompt) received.push(m.message?.content ?? m.text);
    })()) as any;

    const rec = db.createWorker({ id: 'w1', threadRootId: 't1', repoName: 'acme', repoPath: '/repo/acme', task: 'add rate limiting' });
    const w = new Worker({ queryFn, gateway: fakeGateway(), db, pending: new PendingQuestions(db), cfg, record: rec, onFinish: () => {} });
    w.start();

    await vi.waitFor(() => expect(received).toContain('add rate limiting'));
    expect(seenOptions[0].cwd).toBe('/repo/acme');
    expect(seenOptions[0].env.MCP_TIMEOUT).toBe('1000');
    expect(seenOptions[0].allowedTools).toContain('mcp__worker__ask_user');
    await vi.waitFor(() => expect(db.getWorker('w1')!.sessionId).toBe('ws-1'));
  });

  it('marks the worker failed, posts to its thread, and finishes when the session crashes', async () => {
    const posts: { text: string; threadRootId?: string }[] = [];
    const gateway: Gateway = { ...fakeGateway(), post: async (a) => { posts.push(a); return 'p'; } };
    const queryFn = ((_args: any) => (async function* () {
      yield { type: 'system', session_id: 'ws-1' };
      throw new Error('stale resume session');
    })()) as any;

    const rec = db.createWorker({ id: 'w1', threadRootId: 't1', repoName: 'a', repoPath: '/a', task: 'x' });
    let finished = false;
    const w = new Worker({ queryFn, gateway, db, pending: new PendingQuestions(db), cfg, record: rec, onFinish: () => { finished = true; } });
    w.start();

    await vi.waitFor(() => expect(db.getWorker('w1')!.status).toBe('failed'));
    expect(posts.some((p) => p.threadRootId === 't1' && p.text.includes('stale resume session'))).toBe(true);
    expect(finished).toBe(true);
  });

  it('inject appends attachment paths to the pushed message', async () => {
    const received: string[] = [];
    const queryFn = ((args: any) => (async function* () {
      yield { type: 'system', session_id: 's' };
      for await (const m of args.prompt) received.push(m.message?.content ?? m.text);
    })()) as any;
    const rec = db.createWorker({ id: 'w1', threadRootId: 't1', repoName: 'a', repoPath: '/a', task: 'x' });
    const w = new Worker({ queryFn, gateway: fakeGateway(), db, pending: new PendingQuestions(db), cfg, record: rec, onFinish: () => {} });
    w.start();
    await vi.waitFor(() => expect(received.length).toBe(1));
    w.inject('see attached', ['/scratch/spec.md']);
    await vi.waitFor(() => expect(received.some((m) => m.includes('see attached') && m.includes('/scratch/spec.md'))).toBe(true));
  });
});
