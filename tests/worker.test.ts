import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Db } from '../src/db.js';
import { PendingQuestions } from '../src/pending.js';
import { Worker } from '../src/worker.js';
import type { Config } from '../src/config.js';
import type { Gateway } from '../src/mattermost.js';

function fakeGateway(): Gateway {
  return { getBotId: () => 'bot', connect: async () => {}, post: async () => 'p', uploadFile: async () => 'f', downloadFile: async (_i, d) => d, addReaction: async () => {}, removeReaction: async () => {}, close: () => {} };
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

  it('attaches a cluster-write guard hook for investigation workers', async () => {
    const seenOptions: any[] = [];
    const queryFn = ((args: any) => (async function* () {
      seenOptions.push(args.options);
      yield { type: 'system', session_id: 'ws-1' };
      for await (const _m of args.prompt) { /* drain */ }
    })()) as any;

    const rec = db.createWorker({ id: 'w1', threadRootId: 't1', repoName: '(none)', repoPath: '/scratch/w1', task: 'diagnose', kind: 'investigation' });
    const w = new Worker({ queryFn, gateway: fakeGateway(), db, pending: new PendingQuestions(db), cfg, record: rec, onFinish: () => {} });
    w.start();

    await vi.waitFor(() => expect(seenOptions.length).toBe(1));
    const matcher = seenOptions[0].hooks?.PreToolUse?.[0];
    expect(matcher?.matcher).toBe('Bash');
    const hook = matcher.hooks[0];

    const denied = await hook({ tool_name: 'Bash', tool_input: { command: 'kubectl delete pod api-0 -n prod' } }, 'u1', { signal: new AbortController().signal });
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(denied.hookSpecificOutput.permissionDecisionReason).toMatch(/kubectl/i);

    const allowed = await hook({ tool_name: 'Bash', tool_input: { command: 'kubectl get pods -n prod' } }, 'u2', { signal: new AbortController().signal });
    expect(allowed.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });

  it('does not attach the guard hook for feature workers', async () => {
    const seenOptions: any[] = [];
    const queryFn = ((args: any) => (async function* () {
      seenOptions.push(args.options);
      yield { type: 'system', session_id: 'ws-1' };
      for await (const _m of args.prompt) { /* drain */ }
    })()) as any;

    const rec = db.createWorker({ id: 'w1', threadRootId: 't1', repoName: 'acme', repoPath: '/repo/acme', task: 'feature', kind: 'feature' });
    const w = new Worker({ queryFn, gateway: fakeGateway(), db, pending: new PendingQuestions(db), cfg, record: rec, onFinish: () => {} });
    w.start();

    await vi.waitFor(() => expect(seenOptions.length).toBe(1));
    expect(seenOptions[0].hooks).toBeUndefined();
  });

  it('posts a pause notice on a usage limit and a resume notice on recovery', async () => {
    const posts: { text: string; threadRootId?: string }[] = [];
    const gateway: Gateway = { ...fakeGateway(), post: async (a) => { posts.push(a); return 'p'; } };
    const reset = Math.floor(new Date('2026-08-20T15:00:00Z').getTime() / 1000);
    let calls = 0;
    const queryFn = ((args: any) => (async function* () {
      calls++;
      if (calls === 1) throw new Error(`Claude AI usage limit reached|${reset}`);
      yield { type: 'system', session_id: 'ws-1' };
      for await (const _m of args.prompt) { /* drain */ }
    })()) as any;

    const rec = db.createWorker({ id: 'w1', threadRootId: 't1', repoName: 'a', repoPath: '/a', task: 'x' });
    const w = new Worker({ queryFn, gateway, db, pending: new PendingQuestions(db), cfg, record: rec, onFinish: () => {}, wait: () => Promise.resolve() });
    w.start();

    await vi.waitFor(() => expect(posts.some((p) => p.threadRootId === 't1' && /paused/i.test(p.text) && /usage limit/i.test(p.text))).toBe(true));
    await vi.waitFor(() => expect(posts.some((p) => p.threadRootId === 't1' && /resumed/i.test(p.text))).toBe(true));
    expect(db.getWorker('w1')!.status).not.toBe('failed'); // a limit is not a failure
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
