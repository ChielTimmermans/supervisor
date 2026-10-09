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

/** Valid headers for a worker session: X-Repo, X-Session-Id, and the matching "<repo>/worker" X-Agent. */
function workerHeaders(repo: string, sessionId: string): Record<string, string> {
  return { 'X-Repo': repo, 'X-Session-Id': sessionId, 'X-Agent': `${repo}/worker` };
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

  it('rejects a claim_dev call with X-Repo/X-Session-Id but a missing X-Agent header', async () => {
    const { locks } = harness();
    ({ server } = await startServer(locks));
    const url = `http://127.0.0.1:${(server.address() as any).port}/mcp`;
    const { client, transport } = clientFor(url, { 'X-Repo': 'chipmakers', 'X-Session-Id': 'sess-a' });
    await client.connect(transport);

    const result = await client.callTool({ name: 'claim_dev', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toMatch(/X-Agent/);
    await client.close();
  });

  it('rejects a claim_dev call with a wrong X-Agent header', async () => {
    const { locks } = harness();
    ({ server } = await startServer(locks));
    const url = `http://127.0.0.1:${(server.address() as any).port}/mcp`;
    const { client, transport } = clientFor(url, {
      'X-Repo': 'chipmakers',
      'X-Session-Id': 'sess-a',
      'X-Agent': 'chipmakers/claude-worker',
    });
    await client.connect(transport);

    const result = await client.callTool({ name: 'claim_dev', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toMatch(/X-Agent/);
    await client.close();
  });

  it('accepts a claim_dev call with the correct X-Agent header', async () => {
    const { locks } = harness();
    ({ server } = await startServer(locks));
    const url = `http://127.0.0.1:${(server.address() as any).port}/mcp`;
    const { client, transport } = clientFor(url, workerHeaders('chipmakers', 'sess-a'));
    await client.connect(transport);

    const result = await client.callTool({ name: 'claim_dev', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect((result.content as any)[0].text).toMatch(/you now hold/i);
    await client.close();
  });

  it('accepts a different rig\'s "<rig>/worker" X-Agent — the allowlist is not hardcoded to chipmakers', async () => {
    const { locks } = harness();
    ({ server } = await startServer(locks));
    const url = `http://127.0.0.1:${(server.address() as any).port}/mcp`;
    const { client, transport } = clientFor(url, workerHeaders('some-other-rig', 'sess-a'));
    await client.connect(transport);

    const result = await client.callTool({ name: 'claim_dev', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect((result.content as any)[0].text).toMatch(/you now hold/i);
    await client.close();
  });

  it('releases a phantom grant when the waiting client has already abandoned the connection', async () => {
    const { locks } = harness(60_000); // long TTL — this is NOT a stale-break scenario
    ({ server } = await startServer(locks));
    const url = `http://127.0.0.1:${(server.address() as any).port}/mcp`;

    // A holds the repo.
    const a = clientFor(url, workerHeaders('chipmakers', 'sess-a'));
    await a.client.connect(a.transport);
    await a.client.callTool({ name: 'claim_dev', arguments: {} });

    // B queues behind A (via waitFor), then gives up — simulating the MCP SDK client's own
    // request timeout elapsing while the server is still waiting on B's behalf.
    const b = clientFor(url, workerHeaders('chipmakers', 'sess-b'));
    await b.client.connect(b.transport);
    const claimB = b.client.callTool({ name: 'claim_dev', arguments: {} }).catch(() => {});
    await new Promise((r) => setTimeout(r, 100)); // let B's request reach the queued/waiting state
    await b.transport.close(); // B "gives up" — aborts its underlying connection, server-side res goes away
    await claimB;
    await new Promise((r) => setTimeout(r, 100)); // let the abort propagate to the server's res/socket

    // A releases, promoting B's still-pending ticket. B is granted at the DevEnvLocks level,
    // but its connection is gone — the guard must release on B's behalf rather than leave B
    // recorded as holder forever.
    await a.client.callTool({ name: 'release_dev', arguments: {} });
    await new Promise((r) => setTimeout(r, 200)); // let the promotion + abandonment-guard run

    // A third session should be able to claim immediately — proving the dev env is not stuck
    // "held" by abandoned session B.
    const c = clientFor(url, workerHeaders('chipmakers', 'sess-c'));
    await c.client.connect(c.transport);
    const grantC = await c.client.callTool({ name: 'claim_dev', arguments: {} });
    expect((grantC.content as any)[0].text).toMatch(/you now hold/i);
    expect(locks.holderOf('chipmakers')?.workerId).toBe('sess-c');

    await a.client.close();
    await c.client.close();
  });

  it('grants a free repo, makes a second session busy, and promotes it on release', async () => {
    const { locks } = harness();
    ({ server } = await startServer(locks));
    const url = `http://127.0.0.1:${(server.address() as any).port}/mcp`;

    const a = clientFor(url, workerHeaders('chipmakers', 'sess-a'));
    await a.client.connect(a.transport);
    const grantA = await a.client.callTool({ name: 'claim_dev', arguments: {} });
    expect((grantA.content as any)[0].text).toMatch(/you now hold/i);

    const b = clientFor(url, workerHeaders('chipmakers', 'sess-b'));
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

    const a = clientFor(url, workerHeaders('chipmakers', 'sess-a'));
    await a.client.connect(a.transport);
    await a.client.callTool({ name: 'claim_dev', arguments: {} });

    advance(200); // past the 100ms TTL, with no one else waiting

    const b = clientFor(url, workerHeaders('chipmakers', 'sess-b'));
    await b.client.connect(b.transport);
    const grantB = await b.client.callTool({ name: 'claim_dev', arguments: {} });
    expect((grantB.content as any)[0].text).toMatch(/stale hold was broken/i);
    expect(notified).toEqual([{ sessionId: 'sess-a', body: expect.stringContaining('chipmakers') }]);

    await a.client.close();
    await b.client.close();
  });

  it('notifies the prior holder when a queued waiter\'s stale timer breaks and promotes it', async () => {
    const notified: Array<{ sessionId: string; body: string }> = [];
    const { locks, advance } = harness(200);
    ({ server } = await startServer(locks, async (sessionId, _subject, body) => { notified.push({ sessionId, body }); }));
    const url = `http://127.0.0.1:${(server.address() as any).port}/mcp`;

    const a = clientFor(url, workerHeaders('chipmakers', 'sess-a'));
    await a.client.connect(a.transport);
    await a.client.callTool({ name: 'claim_dev', arguments: {} });

    const b = clientFor(url, workerHeaders('chipmakers', 'sess-b'));
    await b.client.connect(b.transport);
    // Kick off B's claim while A's hold is still fresh, so B queues behind it (via waitFor)
    // instead of cold-breaking it — this is the `wr.brokeStale` path, not `res.prior`.
    const claimB = b.client.callTool({ name: 'claim_dev', arguments: {} });

    await new Promise((r) => setTimeout(r, 100)); // let B's request reach the queued/waiting state
    advance(1000); // push the mocked clock well past the 200ms TTL before B's stale timer fires

    const grantB = await claimB;
    // "now yours" (not "a stale hold was broken to grant it") proves B was promoted from the
    // queue via the stale timer (`wr.brokeStale`), not a cold break on a fresh claim (`res.prior`).
    expect((grantB.content as any)[0].text).toMatch(/now yours/i);
    expect(notified).toEqual([
      { sessionId: 'sess-a', body: `Your hold on the chipmakers dev environment was released after being held past the limit.` },
    ]);

    await a.client.close();
    await b.client.close();
  });

  it('notifies the broken prior holder even when the newly-promoted waiter has already abandoned its connection', async () => {
    const notified: Array<{ sessionId: string; body: string }> = [];
    const { locks, advance } = harness(200);
    ({ server } = await startServer(locks, async (sessionId, _subject, body) => { notified.push({ sessionId, body }); }));
    const url = `http://127.0.0.1:${(server.address() as any).port}/mcp`;

    const a = clientFor(url, workerHeaders('chipmakers', 'sess-a'));
    await a.client.connect(a.transport);
    await a.client.callTool({ name: 'claim_dev', arguments: {} });

    const b = clientFor(url, workerHeaders('chipmakers', 'sess-b'));
    await b.client.connect(b.transport);
    const claimB = b.client.callTool({ name: 'claim_dev', arguments: {} }).catch(() => {});

    await new Promise((r) => setTimeout(r, 100)); // let B queue behind A (via waitFor)
    await b.transport.close(); // B abandons before its own stale-break promotion ever fires
    await claimB;

    advance(1000); // past the 200ms TTL — fires B's head-of-queue stale timer, breaking A and promoting B
    await new Promise((r) => setTimeout(r, 200)); // let the stale timer + notify + abandonment guard run

    // A must be told its hold was broken even though B — the session that got promoted — never
    // received the response. This is the fix: notify runs before the abandonment check, not after.
    expect(notified).toEqual([
      { sessionId: 'sess-a', body: `Your hold on the chipmakers dev environment was released after being held past the limit.` },
    ]);

    // And the dev env must not be stuck "held" by abandoned B.
    const c = clientFor(url, workerHeaders('chipmakers', 'sess-c'));
    await c.client.connect(c.transport);
    const grantC = await c.client.callTool({ name: 'claim_dev', arguments: {} });
    expect((grantC.content as any)[0].text).toMatch(/you now hold/i);
    expect(locks.holderOf('chipmakers')?.workerId).toBe('sess-c');

    await a.client.close();
    await c.client.close();
  });
});
