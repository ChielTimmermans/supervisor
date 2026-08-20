import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Db } from '../src/db.js';
import { Supervisor } from '../src/supervisor.js';
import type { Config } from '../src/config.js';
import type { Gateway } from '../src/mattermost.js';

function fakeGateway(posts: { text: string; threadRootId?: string }[]): Gateway {
  return {
    getBotId: () => 'bot', connect: async () => {},
    post: async (a) => { posts.push(a); return 'p'; },
    uploadFile: async () => 'f', downloadFile: async (_i, d) => d,
    addReaction: async () => {}, removeReaction: async () => {}, close: () => {},
  };
}
const cfg = { repos: {}, mattermost: { url: '', token: '', channelId: 'main' } } as Config;
const toolServer = { server: {}, toolNames: [] };

let db: Db;
beforeEach(() => { db = new Db(':memory:'); });

describe('Supervisor', () => {
  it('stays alive on a usage limit: posts a pause notice then resumes (no restart)', async () => {
    const posts: { text: string; threadRootId?: string }[] = [];
    const reset = Math.floor(new Date('2026-08-20T15:00:00Z').getTime() / 1000);
    let calls = 0;
    const received: string[] = [];
    const queryFn = ((args: any) => (async function* () {
      calls++;
      if (calls === 1) throw new Error(`Claude AI usage limit reached|${reset}`);
      yield { type: 'system', session_id: 'sup-1' };
      for await (const m of args.prompt) received.push(m.message?.content ?? m.text);
    })()) as any;

    const sup = new Supervisor({ queryFn, db, cfg, toolServer, gateway: fakeGateway(posts), wait: () => Promise.resolve() });
    sup.start('you are online');

    // Pause notice on the main channel (no thread), then recovery — and the seed message lands.
    await vi.waitFor(() => expect(posts.some((p) => !p.threadRootId && /paused/i.test(p.text) && /usage limit/i.test(p.text))).toBe(true));
    await vi.waitFor(() => expect(received).toContain('you are online'));
    await vi.waitFor(() => expect(posts.some((p) => !p.threadRootId && /resumed/i.test(p.text))).toBe(true));
  });
});
