# Gas City Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install Gas City, configure a city with the chipmakers rig and `worker`/`investigator` pools, and stand up the dev-env lock as a standalone MCP server that Gas City's Claude sessions can call — producing a working city where a sent task can claim and release the shared devbox exactly like today's supervisor does.

**Architecture:** `gc` (the Gas City binary) runs as the supervisor service on the devbox, with a `city.toml` declaring the chipmakers rig and two pools. The dev-env lock's existing business logic (`DevEnvLocks`, `Db`) is reused unmodified behind a new standalone Node process exposing `claim_dev`/`release_dev` as MCP tools over Streamable HTTP, because Gas City spawns one Claude Code process per session rather than one long-lived Node process per worker (today's model) — the lock's in-memory FIFO queue and stale timers only work correctly as a single shared daemon, not one copy per session. Each session's identity (`repo`, `session_id`) comes from HTTP headers set via Claude Code's own `.mcp.json`, using its `${GC_RIG}` / `${GC_SESSION_ID}` environment expansion, not from tool arguments the model could get wrong.

**Tech Stack:** Go (`gc` binary), TOML city config, Node/TypeScript + `@modelcontextprotocol/sdk` (already a dependency) + `express` (new dependency) for the dev-lock server, `better-sqlite3` (already used by `Db`), `vitest`.

**Spec:** `docs/superpowers/specs/2026-10-08-gas-city-migration-design.md`

## Global Constraints

- Claude stays the provider for all agents (spec Non-goals) — Gas City wires its hooks automatically via `gc init`; no agent SDK code is involved.
- Dev-lock semantics are unchanged: `DEV_CLAIM_TTL_MS` (default 1,800,000 ms) governs stale-claim breaking, `DEV_CLAIM_WAIT_TIMEOUT_MS` (default 900,000 ms) governs wait give-up — port the existing values and behavior, don't redesign them.
- Only `worker` agents get the dev-lock tools; `investigator` agents are read-only and never touch the shared devbox (spec Architecture section).
- `worker` pool's `max_active_sessions` takes over today's `WORKER_CONCURRENCY` (currently 3); `investigator` pool's takes over `INVESTIGATION_CONCURRENCY` (currently 2), kept as a separate cap so alert volume can't starve feature work.

## Review Focus

- Two sessions racing to claim the same repo at nearly the same instant — the response to the second request must be `busy`, never a second `granted` (the existing `DevEnvLocks.claim` already guards this; the new HTTP layer must not introduce a race by, e.g., handling requests on a connection pool wider than Node's single event loop thread assumes).
- A session that crashes while holding a claim (Gas City respawns it under a new session ID) — the TTL stale-break must still recover the lock; a holder's crash must never wedge the repo until a human intervenes.
- A misconfigured `.mcp.json` that omits the `X-Repo` or `X-Session-Id` header — the server must fail the request loudly with a clear error, never silently operate on `undefined` as a lock key.
- `gc mail send --notify` failing (binary not on `PATH`, target session already gone) — this is a best-effort notification; a failure must not prevent the claim/release/promotion it was reporting on, and must not crash the server.
- The `investigator` pool must never be able to reach `claim_dev`/`release_dev` at all — not just "the agent is told not to call it," but no `.mcp.json` entry pointing at the dev-lock server exists in an investigator agent's working directory.

---

### Task 1: Install Gas City and verify it runs

**Files:** none (system package installation)

**Interfaces:**
- Produces: a working `gc` binary on `PATH`, used by every later task.

- [ ] **Step 1: Install Gas City**

```bash
brew install gascity
```

If Homebrew isn't available on the devbox, build from source per `docs/getting-started/installation.md` in the `gastownhall/gascity` repo (requires Go 1.26.4+). Record whichever path was used in the commit message for this task.

- [ ] **Step 2: Verify the binary**

Run: `gc --version`
Expected: prints a version string, exit code 0.

- [ ] **Step 3: Verify the supervisor starts and the dashboard is reachable**

Run:
```bash
gc supervisor start
curl -sf http://127.0.0.1:8372/ > /dev/null && echo "dashboard reachable"
```
Expected: `dashboard reachable` printed, no error.

- [ ] **Step 4: Commit**

Nothing to commit from this task (system state only) — note completion in the plan's checkboxes and move on. Do not create an empty commit.

---

### Task 2: Initialize the city and register the chipmakers rig with `worker`/`investigator` pools

**Files:**
- Create: `gas-city/city.toml`
- Create: `gas-city/.gc/site.toml`
- Create: `gas-city/agents/worker/agent.toml`
- Create: `gas-city/agents/worker/prompt.template.md`
- Create: `gas-city/agents/investigator/agent.toml`
- Create: `gas-city/agents/investigator/prompt.template.md`

**Interfaces:**
- Produces: a running city named `supervisor-city` with rig `chipmakers` and pools `worker` (cap 3) and `investigator` (cap 2) — Task 6 slings work into these pools.

- [ ] **Step 1: Initialize the city**

```bash
cd /home/dev/supervisor
gc init gas-city
```

- [ ] **Step 2: Register the chipmakers rig**

```bash
cd gas-city
gc rig add /home/dev/projects/git.sallandpioneers.com/cribr/chipmakers --name chipmakers
```

- [ ] **Step 3: Declare the `worker` pool agent**

Create `gas-city/agents/worker/agent.toml`:

```toml
dir = "chipmakers"
provider = "claude"

[pool]
min_active_sessions = 0
max_active_sessions = 3
```

Create `gas-city/agents/worker/prompt.template.md`:

```markdown
You are a feature-delivery worker for the chipmakers project. You implement
the task described in your slung work, claiming the shared dev environment
with `claim_dev` before running anything against it (dev server, migrations,
seeds, dev deploys, or tests that hit dev) and releasing it with
`release_dev` as soon as you no longer need it. Work until the task is done,
then report what you changed.
```

- [ ] **Step 4: Declare the `investigator` pool agent**

Create `gas-city/agents/investigator/agent.toml`:

```toml
dir = "chipmakers"
provider = "claude"

[pool]
min_active_sessions = 0
max_active_sessions = 2
```

Create `gas-city/agents/investigator/prompt.template.md`:

```markdown
You are a read-only incident investigator for the chipmakers project. You
never modify code, never run migrations or seeds, and never touch the shared
dev environment. Given an alert, investigate using read-only tools only
(logs, metrics, source inspection) and report your findings.
```

- [ ] **Step 5: Verify the pools are visible**

Run: `gc start` (from `gas-city/`), then `gc rig list` and `gc order list`.
Expected: `gc rig list` shows `chipmakers`; `gc order list` runs without
error and shows the bundled housekeeping orders (`beads-health`,
`gate-sweep`, etc.) — confirms the city loaded without config errors.

- [ ] **Step 6: Commit**

```bash
git add gas-city/city.toml gas-city/agents
git commit -m "feat(gas-city): initialize city with chipmakers rig and worker/investigator pools"
```

(`.gc/site.toml` holds machine-local path bindings — check whether `gc init`
added it to `.gitignore`; if not, add it there instead of committing it,
since it's specific to this devbox.)

---

### Task 3: Dev-lock HTTP+MCP server — claim/release over Streamable HTTP

**Files:**
- Create: `src/devlock/app.ts`
- Test: `tests/devlock/app.test.ts`
- Modify: `package.json` (add `express` dependency)

**Interfaces:**
- Consumes: `Db` from `src/db.ts` (constructor `new Db(path: string)`, methods `getDevClaim`, `tryClaimDev`, `forceSetDevClaim`, `releaseDevClaim`, `forceReleaseDevClaim`, `deleteDevClaimsByWorker`, `listDevClaims` — all already implemented); `DevEnvLocks` from `src/devEnvLocks.ts` (constructor `new DevEnvLocks(db, {ttlMs, waitTimeoutMs, now?, schedule?})`, methods `claim(repo, workerId, threadRootId)`, `waitFor(ticket)`, `release(repo, workerId)`, `forceRelease(repo)`, `releaseAllFor(workerId)`, `reconcile(isActive)`, `holderOf(repo)`).
- Produces: `createDevlockApp(locks: DevEnvLocks): express.Express` — an Express app with a single `POST /mcp` route exposing `claim_dev` and `release_dev` MCP tools, reading `repo` from the `X-Repo` header and `session_id` from the `X-Session-Id` header. Later tasks (4, 5) extend this app; they do not change this signature.

- [ ] **Step 1: Write the failing test for a missing identity header**

```typescript
// tests/devlock/app.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Server } from 'node:http';
import { Db } from '../../src/db.js';
import { DevEnvLocks } from '../../src/devEnvLocks.js';
import { createDevlockApp } from '../../src/devlock/app.js';

function harness() {
  let now = 0;
  const schedule = (fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  };
  const db = new Db(':memory:');
  const locks = new DevEnvLocks(db, { ttlMs: 60_000, waitTimeoutMs: 30_000, now: () => now, schedule });
  return { db, locks };
}

async function startServer(locks: DevEnvLocks): Promise<{ server: Server; url: string }> {
  const app = createDevlockApp(locks);
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/devlock/app.test.ts`
Expected: FAIL — `Cannot find module '../../src/devlock/app.js'` (the file doesn't exist yet).

- [ ] **Step 3: Add the `express` dependency**

```bash
pnpm add express
```

- [ ] **Step 4: Write the minimal implementation**

```typescript
// src/devlock/app.ts
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { DevEnvLocks } from '../devEnvLocks.js';

function identityFromHeaders(req: express.Request): { repo: string; sessionId: string } | undefined {
  const repo = req.header('x-repo');
  const sessionId = req.header('x-session-id');
  if (!repo || !sessionId) return undefined;
  return { repo, sessionId };
}

function buildServer(locks: DevEnvLocks, repo: string, sessionId: string): McpServer {
  const server = new McpServer({ name: 'devlock', version: '1.0.0' });

  server.registerTool(
    'claim_dev',
    {
      description:
        "Claim exclusive use of this repo's shared dev environment before you use it (dev server, migrations, seeds, deploying to dev, or tests that hit dev). Only one worker holds it at a time; if it's busy this blocks until it frees, then returns. Always call release_dev when done.",
      inputSchema: {},
    },
    async () => {
      const res = locks.claim(repo, sessionId, sessionId);
      if (res.status === 'granted' || res.status === 'granted-broke-stale') {
        return { content: [{ type: 'text', text: `You now hold the ${repo} dev environment. Call release_dev when done.` }] };
      }
      const wr = await locks.waitFor(res.ticket);
      if (wr.status === 'granted') {
        return { content: [{ type: 'text', text: `The ${repo} dev environment is now yours. Call release_dev when done.` }] };
      }
      return { content: [{ type: 'text', text: `The ${repo} dev environment is still busy; you do NOT hold it.` }] };
    },
  );

  server.registerTool(
    'release_dev',
    {
      description: "Release this repo's shared dev environment so another session can use it.",
      inputSchema: {},
    },
    async () => {
      const res = locks.release(repo, sessionId);
      if (!res.released) {
        return { content: [{ type: 'text', text: `You don't currently hold the ${repo} dev environment.` }] };
      }
      return { content: [{ type: 'text', text: `Released the ${repo} dev environment${res.promoted ? ' — handed off to a waiting session.' : '.'}` }] };
    },
  );

  return server;
}

export function createDevlockApp(locks: DevEnvLocks): express.Express {
  const app = express();
  app.use(express.json());

  app.post('/mcp', async (req, res) => {
    const identity = identityFromHeaders(req);
    if (!identity) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32602, message: 'Missing required X-Repo or X-Session-Id header' },
        id: req.body?.id ?? null,
      });
      return;
    }
    const server = buildServer(locks, identity.repo, identity.sessionId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => { transport.close(); server.close(); });
  });

  return app;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run tests/devlock/app.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the claim/busy/release happy-path test**

```typescript
// append to tests/devlock/app.test.ts
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
```

- [ ] **Step 7: Run tests to verify both pass**

Run: `pnpm vitest run tests/devlock/app.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
git add src/devlock/app.ts tests/devlock/app.test.ts package.json pnpm-lock.yaml
git commit -m "feat(devlock): serve claim_dev/release_dev as an MCP tool over Streamable HTTP"
```

---

### Task 4: Stale-break and promotion notifications via `gc mail send`

**Files:**
- Create: `src/devlock/notify.ts`
- Modify: `src/devlock/app.ts`
- Test: `tests/devlock/notify.test.ts`
- Test: `tests/devlock/app.test.ts` (extend)

**Interfaces:**
- Consumes: `DevClaim` type from `src/types.ts` (`{ repoName, workerId, threadRootId, claimedAt }` — note `workerId`/`threadRootId` both hold the Gas City `session_id` in this new usage, per Task 3).
- Produces: `createGcMailNotifier(gcBin?: string): (sessionId: string, subject: string, body: string) => Promise<void>` — used by `createDevlockApp`'s second parameter, added in this task: `createDevlockApp(locks, notify)`.

- [ ] **Step 1: Write the failing test for the notifier**

```typescript
// tests/devlock/notify.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGcMailNotifier } from '../../src/devlock/notify.js';

describe('createGcMailNotifier', () => {
  let dir: string;
  let logPath: string;
  let stubPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'devlock-notify-'));
    logPath = join(dir, 'calls.log');
    stubPath = join(dir, 'gc');
    writeFileSync(stubPath, `#!/bin/sh\necho "$@" >> "${logPath}"\n`);
    chmodSync(stubPath, 0o755);
  });

  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('invokes gc mail send with --notify and the recipient session id', async () => {
    const notify = createGcMailNotifier(stubPath);
    await notify('sess-b', 'dev-env', 'Your claim was broken.');
    const calls = readFileSync(logPath, 'utf8').trim();
    expect(calls).toBe('mail send sess-b -s dev-env -m Your claim was broken. --notify');
  });

  it('does not throw when the gc binary is missing', async () => {
    const notify = createGcMailNotifier('/no/such/gc');
    await expect(notify('sess-b', 'dev-env', 'hi')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/devlock/notify.test.ts`
Expected: FAIL — `Cannot find module '../../src/devlock/notify.js'`.

- [ ] **Step 3: Write the minimal implementation**

```typescript
// src/devlock/notify.ts
import { execFile } from 'node:child_process';
import { log } from '../log.js';

export type Notify = (sessionId: string, subject: string, body: string) => Promise<void>;

export function createGcMailNotifier(gcBin = 'gc'): Notify {
  return (sessionId, subject, body) =>
    new Promise<void>((resolve) => {
      execFile(gcBin, ['mail', 'send', sessionId, '-s', subject, '-m', body, '--notify'], (err) => {
        if (err) log.warn('devlock: gc mail send failed (best-effort, ignoring)', { sessionId, error: String(err) });
        resolve();
      });
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/devlock/notify.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the notifier into the app on stale-break and promotion**

Modify `src/devlock/app.ts`: change `createDevlockApp`'s signature and the `claim_dev` handler.

```typescript
// src/devlock/app.ts — changes only
import type { Notify } from './notify.js';

function buildServer(locks: DevEnvLocks, repo: string, sessionId: string, notify: Notify): McpServer {
  // ... McpServer construction unchanged above claim_dev ...

  server.registerTool(
    'claim_dev',
    { description: /* unchanged */ '', inputSchema: {} },
    async () => {
      const res = locks.claim(repo, sessionId, sessionId);
      if (res.status === 'granted') {
        return { content: [{ type: 'text', text: `You now hold the ${repo} dev environment. Call release_dev when done.` }] };
      }
      if (res.status === 'granted-broke-stale') {
        await notify(res.prior.workerId, 'dev-env', `Your hold on the ${repo} dev environment was released after being held past the limit. Another session has taken it.`);
        return { content: [{ type: 'text', text: `You now hold the ${repo} dev environment (a stale hold was broken to grant it). Call release_dev when done.` }] };
      }
      const wr = await locks.waitFor(res.ticket);
      if (wr.status === 'granted') {
        if (wr.brokeStale) {
          await notify(wr.brokeStale.workerId, 'dev-env', `Your hold on the ${repo} dev environment was released after being held past the limit.`);
        }
        return { content: [{ type: 'text', text: `The ${repo} dev environment is now yours. Call release_dev when done.` }] };
      }
      return { content: [{ type: 'text', text: `The ${repo} dev environment is still busy; you do NOT hold it.` }] };
    },
  );

  // release_dev tool body unchanged from Task 3

  return server;
}

export function createDevlockApp(locks: DevEnvLocks, notify: Notify): express.Express {
  const app = express();
  app.use(express.json());

  app.post('/mcp', async (req, res) => {
    const identity = identityFromHeaders(req);
    if (!identity) {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32602, message: 'Missing required X-Repo or X-Session-Id header' }, id: req.body?.id ?? null });
      return;
    }
    const server = buildServer(locks, identity.repo, identity.sessionId, notify);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => { transport.close(); server.close(); });
  });

  return app;
}
```

Update every `createDevlockApp(locks)` call in `tests/devlock/app.test.ts`'s `startServer` helper to `createDevlockApp(locks, async () => {})` (a no-op stub notifier) so Task 3's tests keep passing unchanged.

- [ ] **Step 6: Write the test proving a broken stale holder gets notified**

```typescript
// append to tests/devlock/app.test.ts
it('notifies the prior holder when its stale claim is broken', async () => {
  const notified: Array<{ sessionId: string; body: string }> = [];
  const { locks } = harness();
  ({ server } = await startServer(locks, async (sessionId, _subject, body) => { notified.push({ sessionId, body }); }));
  const url = `http://127.0.0.1:${(server.address() as any).port}/mcp`;

  const a = clientFor(url, { 'X-Repo': 'chipmakers', 'X-Session-Id': 'sess-a' });
  await a.client.connect(a.transport);
  await a.client.callTool({ name: 'claim_dev', arguments: {} });

  // Force the TTL to have elapsed by claiming via a locks instance whose `now` has advanced
  // past ttlMs with no one else waiting — simulate by calling locks.forceRelease is wrong (that's
  // operator-initiated); instead, drive time forward through the harness `now` stand-in used by
  // this test's `locks`, then have a second session claim.
  // (harness() in this file exposes a mutable `now` closure variable — advance it here.)
  // See Step 7 for the harness change this test depends on.

  const b = clientFor(url, { 'X-Repo': 'chipmakers', 'X-Session-Id': 'sess-b' });
  await b.client.connect(b.transport);
  const grantB = await b.client.callTool({ name: 'claim_dev', arguments: {} });
  expect((grantB.content as any)[0].text).toMatch(/stale hold was broken/i);
  expect(notified).toEqual([{ sessionId: 'sess-a', body: expect.stringContaining('chipmakers') }]);

  await a.client.close();
  await b.client.close();
});
```

- [ ] **Step 7: Make the test's TTL actually elapse**

Change the `harness()` helper in `tests/devlock/app.test.ts` to return the mutable `now` setter alongside `locks`, and the `startServer` helper to accept an optional notifier:

```typescript
function harness(ttlMs = 60_000) {
  let now = 0;
  const schedule = (fn: () => void, ms: number) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); };
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
```

In the stale-break test from Step 6, use `const { locks, advance } = harness(100);` and call `advance(200);` after session A claims and before session B claims, so A's hold is provably past its 100ms TTL when B claims.

- [ ] **Step 8: Run all devlock tests to verify they pass**

Run: `pnpm vitest run tests/devlock/`
Expected: PASS (all tests in both files).

- [ ] **Step 9: Commit**

```bash
git add src/devlock/app.ts src/devlock/notify.ts tests/devlock/
git commit -m "feat(devlock): notify the prior holder via gc mail send on stale-break/promotion"
```

---

### Task 5: Server entrypoint with startup reconciliation against live Gas City sessions

**Files:**
- Create: `src/devlock/sessions.ts`
- Create: `src/devlock/server.ts`
- Test: `tests/devlock/sessions.test.ts`
- Modify: `package.json` (add `"devlock": "tsx src/devlock/server.ts"` script)

**Interfaces:**
- Consumes: `createDevlockApp` and `createGcMailNotifier` from Tasks 3–4; `DevEnvLocks.reconcile(isActive: (workerId: string) => boolean): void` from `src/devEnvLocks.ts` (already implemented, unchanged).
- Produces: `listActiveSessionIds(gcBin?: string): Promise<Set<string>>` — used once at process startup by `server.ts` to call `locks.reconcile(id => activeIds.has(id))`, dropping persisted claims whose holder is no longer a live Gas City session.

- [ ] **Step 1: Confirm the real field name `gc session list --json` emits**

Run (with `gc` installed from Task 1, against the city from Task 2):
```bash
cd /home/dev/supervisor/gas-city && gc session list --json
```
Read the output. Gas City's internal session type uses the key `session_id` in bead metadata (confirmed from `gastownhall/gascity`'s `internal/session/waits.go`); the CLI's top-level list output may use `id` or `session_id` for the same value — write down which one it actually is before Step 3, and use that exact key in `listActiveSessionIds`. If no sessions are currently running, `gc sling worker "echo hi"` first so there's at least one row to inspect.

- [ ] **Step 2: Write the failing test for `listActiveSessionIds`**

```typescript
// tests/devlock/sessions.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listActiveSessionIds } from '../../src/devlock/sessions.js';

describe('listActiveSessionIds', () => {
  let dir: string;
  let stubPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'devlock-sessions-'));
    stubPath = join(dir, 'gc');
    writeFileSync(
      stubPath,
      `#!/bin/sh\necho '[{"id":"sess-a"},{"id":"sess-b"}]'\n`,
    );
    chmodSync(stubPath, 0o755);
  });

  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('parses session ids out of gc session list --json', async () => {
    const ids = await listActiveSessionIds(stubPath);
    expect(ids).toEqual(new Set(['sess-a', 'sess-b']));
  });

  it('returns an empty set if gc is unreachable, without throwing', async () => {
    const ids = await listActiveSessionIds('/no/such/gc');
    expect(ids).toEqual(new Set());
  });
});
```

Adjust the stub's JSON key from `id` to whatever Step 1 found, before trusting this test as the spec for the implementation.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run tests/devlock/sessions.test.ts`
Expected: FAIL — `Cannot find module '../../src/devlock/sessions.js'`.

- [ ] **Step 4: Write the minimal implementation**

```typescript
// src/devlock/sessions.ts
import { execFile } from 'node:child_process';
import { log } from '../log.js';

export function listActiveSessionIds(gcBin = 'gc'): Promise<Set<string>> {
  return new Promise((resolve) => {
    execFile(gcBin, ['session', 'list', '--json'], (err, stdout) => {
      if (err) {
        log.warn('devlock: gc session list failed; reconciling against an empty session set', { error: String(err) });
        resolve(new Set());
        return;
      }
      try {
        const rows = JSON.parse(stdout) as Array<{ id: string }>;
        resolve(new Set(rows.map((r) => r.id)));
      } catch (parseErr) {
        log.warn('devlock: could not parse gc session list --json output', { error: String(parseErr) });
        resolve(new Set());
      }
    });
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run tests/devlock/sessions.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Write the server entrypoint**

```typescript
// src/devlock/server.ts
import 'dotenv/config';
import { Db } from '../db.js';
import { DevEnvLocks } from '../devEnvLocks.js';
import { createDevlockApp } from './app.js';
import { createGcMailNotifier } from './notify.js';
import { listActiveSessionIds } from './sessions.js';
import { log } from '../log.js';

async function main() {
  const gcBin = process.env.GC_BIN ?? 'gc';
  const dbPath = process.env.DEVLOCK_DB_PATH ?? './data/devlock.sqlite';
  const port = Number(process.env.DEVLOCK_PORT ?? 4810);
  const ttlMs = process.env.DEV_CLAIM_TTL_MS ? Number(process.env.DEV_CLAIM_TTL_MS) : 1_800_000;
  const waitTimeoutMs = process.env.DEV_CLAIM_WAIT_TIMEOUT_MS ? Number(process.env.DEV_CLAIM_WAIT_TIMEOUT_MS) : 900_000;

  const db = new Db(dbPath);
  const locks = new DevEnvLocks(db, { ttlMs, waitTimeoutMs });

  const activeIds = await listActiveSessionIds(gcBin);
  locks.reconcile((workerId) => activeIds.has(workerId));
  log.info('devlock: startup reconciliation complete', { activeSessions: activeIds.size });

  const app = createDevlockApp(locks, createGcMailNotifier(gcBin));
  app.listen(port, () => log.info('devlock: listening', { port }));
}

main().catch((err) => {
  log.error('devlock: fatal startup error', { error: String(err) });
  process.exit(1);
});
```

- [ ] **Step 7: Add the npm script**

Modify `package.json`'s `"scripts"` block to add:

```json
"devlock": "tsx src/devlock/server.ts"
```

- [ ] **Step 8: Verify the server starts for real**

Run:
```bash
pnpm devlock &
sleep 1
curl -s -X POST http://127.0.0.1:4810/mcp -H 'content-type: application/json' -d '{}'
kill %1
```
Expected: the server logs `devlock: listening` and the curl gets a `400` JSON-RPC error body (missing headers) rather than a connection refusal — proves the process starts and the route is live.

- [ ] **Step 9: Commit**

```bash
git add src/devlock/sessions.ts src/devlock/server.ts tests/devlock/sessions.test.ts package.json
git commit -m "feat(devlock): add server entrypoint with startup reconciliation against live gc sessions"
```

---

### Task 6: Wire the dev-lock server into the `worker` agent and verify two-session contention end-to-end

**Files:**
- Create: `gas-city/agents/worker/mcp.json`
- Modify: `gas-city/agents/worker/agent.toml`

**Interfaces:**
- Consumes: the running `devlock` server from Task 5 (`pnpm devlock`, port from `DEVLOCK_PORT`).
- Produces: a `worker` agent that can call `claim_dev`/`release_dev` during a real Gas City session, proving the whole chain (Gas City → Claude Code → MCP header expansion → devlock server → `DevEnvLocks`) end-to-end — while `investigator` sessions get no access to these tools at all. This is the deliverable Plan 2 (Mattermost bridge) builds on.

**Important correction to Task 2's setup:** `worker` and `investigator` both have `dir = "chipmakers"`, i.e. they share the *same* working directory (the rig's checkout). A project-root `.mcp.json` would therefore be visible to both agents, violating the Review Focus constraint that investigator sessions must never reach `claim_dev`/`release_dev`. Instead, pass the MCP config as a per-agent CLI flag via `agent.toml`'s `args_append` (documented in Gas City's config reference: "ArgsAppend accumulates extra args after each layer's Args replacement"), pointing at an MCP config file that lives next to the `worker` agent's own definition, not in the shared rig directory. Only `worker`'s `agent.toml` gets this; `investigator`'s is untouched.

- [ ] **Step 1: Write the MCP config file**

Create `gas-city/agents/worker/mcp.json`:

```json
{
  "mcpServers": {
    "devlock": {
      "type": "http",
      "url": "http://127.0.0.1:4810/mcp",
      "headers": {
        "X-Repo": "${GC_RIG}",
        "X-Session-Id": "${GC_SESSION_ID}"
      }
    }
  }
}
```

- [ ] **Step 2: Point the `worker` agent at it**

Modify `gas-city/agents/worker/agent.toml` (created in Task 2) to add:

```toml
args_append = ["--mcp-config", "/home/dev/supervisor/gas-city/agents/worker/mcp.json"]
```

Leave `gas-city/agents/investigator/agent.toml` exactly as Task 2 left it — no `args_append`, no MCP config, so it has no path to `claim_dev`/`release_dev` at all.

- [ ] **Step 3: Start the devlock server and the city**

```bash
cd /home/dev/supervisor && pnpm devlock &
cd gas-city && gc start
```

- [ ] **Step 4: Sling a task that exercises claim_dev/release_dev**

```bash
gc sling chipmakers/worker "Call claim_dev, then immediately call release_dev, then report what each call returned. Do not touch any files."
```

- [ ] **Step 5: Verify the tool calls actually happened**

Run: `gc session list --template chipmakers/worker` to find the session ID, then `gc session peek <id> --lines 40`.
Expected: the transcript shows the agent calling `claim_dev` and getting "You now hold the chipmakers dev environment...", then calling `release_dev` and getting "Released the chipmakers dev environment.". Also check the devlock server's stdout/log for the matching `claimed dev env` / `released dev env`-style activity (the structured `log.info` calls already wired in Tasks 3–4).

- [ ] **Step 6: Verify two-session contention**

```bash
gc sling chipmakers/worker "Call claim_dev and report its result. Then wait 10 seconds (sleep via a shell tool if you have one, or just pause your own turn) before calling release_dev."
gc sling chipmakers/worker "Immediately call claim_dev and report exactly what it returns."
```

Expected: the second session's `claim_dev` call reports the environment as busy and then becomes yours once the first session releases it (the "busy, then waits, then granted" flow from Task 3's happy-path test) — confirming the behavior proven in unit tests also holds against the real `gc` binary, real Claude Code sessions, and the real MCP header-expansion path, not just the vitest harness.

- [ ] **Step 7: Commit**

Both changed files (`gas-city/agents/worker/mcp.json`, `gas-city/agents/worker/agent.toml`) live in the `supervisor` repo, same as Task 2's city config:

```bash
cd /home/dev/supervisor
git add gas-city/agents/worker/mcp.json gas-city/agents/worker/agent.toml
git commit -m "feat(gas-city): wire the worker agent to the devlock MCP server via args_append"
```
