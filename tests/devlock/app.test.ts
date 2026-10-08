import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Server } from 'node:http';
import { Db } from '../../src/db.js';
import { DevEnvLocks } from '../../src/devEnvLocks.js';
import { createDevlockApp } from '../../src/devlock/app.js';
import type { Notify } from '../../src/devlock/notify.js';

function harness(ttlMs = 60_000) {
  let now = 0;
  const schedule = (fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  };
  const db = new Db(':memory:');
  const locks = new DevEnvLocks(db, { ttlMs, waitTimeoutMs: 30_000, now: () => now, schedule });
  return { db, locks, advance: (ms: number) => { now += ms; } };
}

async function startServer(locks: DevEnvLocks, notify: Notify = async () => {}): Promise<{ server: Server; url: string }> {
  const app = createDevlockApp(locks, notify);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  return { server, url: `http://127.0.0.1:${port}/mcp` };
}

function clientFor(url: string, headers?: Record<string, string>) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: headers ? { headers } : undefined,
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  return { client, transport };
}

describe('devlock app', () => {
  let server: Server;

  afterEach(() => { server?.close(); });

  it('rejects a claim_dev call with no identity headers', async () => {
    const { locks } = harness();
    ({ server } = await startServer(locks));
    const url = (server.address() as { port: number } satisfies object) && `http://127.0.0.1:${(server.address() as any).port}/mcp`;
    const { client, transport } = clientFor(url);
    await client.connect(transport);

    const result = await client.callTool({ name: 'claim_dev', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toMatch(/X-Repo|X-Session-Id/);
    await client.close();
  });

  it('grants a free repo, makes a second session busy, and promotes it on release', async () => {
    const { locks } = harness();
    ({ server } = await startServer(locks));
    const url = `http://127.0.0.1:${(server.address() as any).port}/mcp`;

    const a = clientFor(url, { 'X-Repo': 'chipmakers', 'X-Session-Id': 'sess-a' });
    await a.client.connect(a.transport);
    const grantA = await a.client.callTool({ name: 'claim_dev', arguments: {} });
    expect((grantA.content as any)[0].text).toMatch(/you now hold/i);

    const b = clientFor(url, { 'X-Repo': 'chipmakers', 'X-Session-Id': 'sess-b' });
    await b.client.connect(b.transport);
    const claimB = b.client.callTool({ name: 'claim_dev', arguments: {} });

    await new Promise((r) => setTimeout(r, 50)); // let B's request reach the busy/wait state
    const releaseA = await a.client.callTool({ name: 'release_dev', arguments: {} });
    expect((releaseA.content as any)[0].text).toMatch(/handed off/i);

    const grantB = await claimB;
    expect((grantB.content as any)[0].text).toMatch(/now yours/i);

    await a.client.close();
    await b.client.close();
  });

  it('notifies the prior holder when its stale claim is broken', async () => {
    const notified: Array<{ sessionId: string; body: string }> = [];
    const { locks, advance } = harness(100);
    ({ server } = await startServer(locks, async (sessionId, _subject, body) => { notified.push({ sessionId, body }); }));
    const url = `http://127.0.0.1:${(server.address() as any).port}/mcp`;

    const a = clientFor(url, { 'X-Repo': 'chipmakers', 'X-Session-Id': 'sess-a' });
    await a.client.connect(a.transport);
    await a.client.callTool({ name: 'claim_dev', arguments: {} });

    advance(200); // past the 100ms TTL, with no one else waiting

    const b = clientFor(url, { 'X-Repo': 'chipmakers', 'X-Session-Id': 'sess-b' });
    await b.client.connect(b.transport);
    const grantB = await b.client.callTool({ name: 'claim_dev', arguments: {} });
    expect((grantB.content as any)[0].text).toMatch(/stale hold was broken/i);
    expect(notified).toEqual([{ sessionId: 'sess-a', body: expect.stringContaining('chipmakers') }]);

    await a.client.close();
    await b.client.close();
  });
});
