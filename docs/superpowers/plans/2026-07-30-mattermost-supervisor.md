# Mattermost Supervisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Node/TypeScript service ("the Bridge") that gives Claude Code a Mattermost chat interface: a persistent Supervisor session spawns per-feature Worker sessions in local repos, and workers talk back to the operator (questions, artifacts) through Mattermost threads.

**Architecture:** One always-on Node process (the Bridge) holds a Mattermost WebSocket + REST connection and a SQLite store. It drives Claude Code sessions via the Claude Agent SDK: one persistent Supervisor session (orchestration) and one Worker session per feature (coding, cwd = target repo). Custom in-process MCP tools are how sessions act on Mattermost and how the operator's replies resume a blocked worker. Message routing is a pure function; everything else is thin wiring.

**Tech Stack:** TypeScript (ESM), Node.js ≥ 22, `@anthropic-ai/claude-agent-sdk`, `@mattermost/client` + `@mattermost/types`, `ws`, `better-sqlite3`, `zod`, `dotenv`; Vitest for tests; `tsx` for running.

## Global Constraints

- **Node.js ≥ 22** — relies on global `fetch`, `FormData`, `Blob`. Provide a WebSocket implementation via the `ws` package (inject through `WebSocketClientConfig.newWebSocketFn`); polyfill `globalThis.CloseEvent` if the runtime lacks it.
- **Language:** TypeScript, ESM (`"type": "module"`), `moduleResolution: "bundler"` or `"nodenext"`.
- **Test runner:** Vitest. Every task is TDD: failing test → run (fail) → implement → run (pass) → commit.
- **Model & permissions:** all Claude sessions run with `permissionMode: 'bypassPermissions'`. Worker sessions set `env: { ...process.env, MCP_TIMEOUT: String(config.askUserTimeoutMs) }` (default `86400000` = 24h) so the blocking `ask_user` tool does not hit the SDK's default 30 s MCP tool timeout.
- **MCP tool naming:** SDK exposes in-process tools as `mcp__<serverName>__<toolName>`. Server names: `supervisor` and `worker`.
- **Mattermost:** `Client4.setUrl(baseUrl)` takes the bare server URL (no `/api/v4`). Bot auth is `setToken(botToken)`. Thread replies set `root_id: post.root_id || post.id`. New-post WS event is `'posted'`; the post is a JSON string in `msg.data.post`; filter on `msg.broadcast.channel_id`.
- **Version control:** the operator's policy requires **explicit approval before any commit**, and commit messages **must not** include a `Co-Authored-By` trailer. Treat each "Commit" step as: stage the listed files and pause for operator approval (the operator may pre-authorize per-task committing at execution start).
- **No secrets in code:** all credentials come from environment / `.env` (gitignored).
- **SDK type caveat:** the exact `SDKUserMessage` shape and `systemPrompt` option shape must be confirmed against the installed SDK's exported types during Task 5 / Task 8–9 (the plan uses the documented shapes and imports the SDK types so `tsc` validates them).

## File Structure

```
supervisor/
  package.json
  tsconfig.json
  vitest.config.ts
  .gitignore
  .env.example
  src/
    config.ts          # env + repo-registry loading; Config type
    db.ts              # SQLite schema + typed accessors (workers, pending_questions, meta)
    types.ts           # shared domain types (IncomingPost, WorkerRecord, RouteAction, ...)
    mattermost.ts      # MattermostGateway: WS connect, post/reply, upload/download, getBotId; + pure helpers
    session.ts         # ClaudeSession: streaming-input queue, run loop, session-id capture, resume, stop
    router.ts          # pure routing: (post, state) -> RouteAction
    pending.ts         # PendingQuestions registry (in-memory resolvers backed by db)
    tools/
      workerTools.ts     # ask_user, send_update, finish  (factory)
      supervisorTools.ts # list_repos, spawn_worker, list_workers, post_to_channel, stop_worker (factory)
    worker.ts          # Worker: ClaudeSession + thread binding + inbound injection
    supervisor.ts      # Supervisor: ClaudeSession + persistence/resume + seed
    bridge.ts          # wires gateway events -> router -> supervisor/workers; startup reconciliation
    index.ts           # entrypoint: load config, init db, real gateway/sessions, start bridge
  tests/
    config.test.ts
    db.test.ts
    mattermost.helpers.test.ts
    router.test.ts
    session.test.ts
    pending.test.ts
    workerTools.test.ts
    supervisorTools.test.ts
    bridge.test.ts
    integration.test.ts
```

---

### Task 1: Project scaffolding & config

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`
- Create: `src/config.ts`, `src/types.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces:
  - `type RepoEntry = { path: string; description: string }`
  - `type Config = { mattermost: { url: string; token: string; channelId: string }; repos: Record<string, RepoEntry>; workerConcurrency: number; askUserTimeoutMs: number; attachmentDir: string; model?: string }`
  - `loadConfig(env: NodeJS.ProcessEnv, reposJson: string): Config` — pure; throws on missing required fields.
  - `src/types.ts` exports domain types used across tasks (filled in as later tasks reference them; start with the ones below).

- [ ] **Step 1: Initialize the repo and install dependencies**

```bash
cd /Users/chiel/projects/github.com/chieltimmermans/supervisor
git init
npm init -y
npm pkg set type=module
npm i @anthropic-ai/claude-agent-sdk @mattermost/client @mattermost/types ws better-sqlite3 zod dotenv
npm i -D typescript tsx vitest @types/node @types/ws @types/better-sqlite3
```

- [ ] **Step 2: Add `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src", "tests"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node' } });
```

`.gitignore`:
```
node_modules
dist
.env
data/
*.sqlite
scratch/
```

`.env.example`:
```
MM_URL=https://mattermost.example.com
MM_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxx
MM_CHANNEL_ID=xxxxxxxxxxxxxxxxxxxxxxxxx
REPOS_JSON={"acme-api":{"path":"/Users/chiel/projects/acme-api","description":"Main API service"}}
WORKER_CONCURRENCY=3
ASK_USER_TIMEOUT_MS=86400000
ATTACHMENT_DIR=./scratch/attachments
DB_PATH=./data/supervisor.sqlite
```

- [ ] **Step 3: Write the failing test**

`tests/config.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  MM_URL: 'https://mm.example.com',
  MM_TOKEN: 'tok',
  MM_CHANNEL_ID: 'chan',
  WORKER_CONCURRENCY: '2',
  ASK_USER_TIMEOUT_MS: '1000',
  ATTACHMENT_DIR: './scratch',
};
const repos = '{"acme-api":{"path":"/repo/acme","description":"API"}}';

describe('loadConfig', () => {
  it('parses env + repo registry', () => {
    const c = loadConfig(base, repos);
    expect(c.mattermost.url).toBe('https://mm.example.com');
    expect(c.repos['acme-api'].path).toBe('/repo/acme');
    expect(c.workerConcurrency).toBe(2);
    expect(c.askUserTimeoutMs).toBe(1000);
  });

  it('throws when a required field is missing', () => {
    expect(() => loadConfig({ ...base, MM_TOKEN: undefined } as any, repos)).toThrow(/MM_TOKEN/);
  });

  it('defaults concurrency and timeout when absent', () => {
    const c = loadConfig({ ...base, WORKER_CONCURRENCY: undefined, ASK_USER_TIMEOUT_MS: undefined } as any, repos);
    expect(c.workerConcurrency).toBe(3);
    expect(c.askUserTimeoutMs).toBe(86_400_000);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL (`loadConfig` not found).

- [ ] **Step 5: Implement `src/types.ts` and `src/config.ts`**

`src/types.ts`:
```ts
export type WorkerStatus = 'running' | 'waiting' | 'finished' | 'failed';

export interface IncomingPost {
  id: string;
  channelId: string;
  rootId: string;      // '' for top-level, else the thread root post id
  message: string;
  userId: string;
  fileIds: string[];
  isOwn: boolean;      // authored by the bot itself
}

export interface WorkerRecord {
  id: string;
  threadRootId: string;
  repoName: string;
  repoPath: string;
  sessionId: string | null;
  status: WorkerStatus;
  task: string;
  createdAt: number;
  updatedAt: number;
}
```

`src/config.ts`:
```ts
export interface RepoEntry { path: string; description: string }

export interface Config {
  mattermost: { url: string; token: string; channelId: string };
  repos: Record<string, RepoEntry>;
  workerConcurrency: number;
  askUserTimeoutMs: number;
  attachmentDir: string;
  dbPath: string;
  model?: string;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required env: ${key}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv, reposJson: string): Config {
  const repos = JSON.parse(reposJson) as Record<string, RepoEntry>;
  return {
    mattermost: {
      url: required(env, 'MM_URL'),
      token: required(env, 'MM_TOKEN'),
      channelId: required(env, 'MM_CHANNEL_ID'),
    },
    repos,
    workerConcurrency: env.WORKER_CONCURRENCY ? Number(env.WORKER_CONCURRENCY) : 3,
    askUserTimeoutMs: env.ASK_USER_TIMEOUT_MS ? Number(env.ASK_USER_TIMEOUT_MS) : 86_400_000,
    attachmentDir: env.ATTACHMENT_DIR ?? './scratch/attachments',
    dbPath: env.DB_PATH ?? './data/supervisor.sqlite',
    model: env.MODEL,
  };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit** (stage; await approval per version-control policy)

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .env.example src/config.ts src/types.ts tests/config.test.ts
git commit -m "chore: scaffold project and config loader"
```

---

### Task 2: SQLite store

**Files:**
- Create: `src/db.ts`
- Test: `tests/db.test.ts`

**Interfaces:**
- Consumes: `WorkerRecord`, `WorkerStatus` from `src/types.ts`.
- Produces `class Db`:
  - `constructor(path: string)` — opens `better-sqlite3`, runs schema migration.
  - `createWorker(w: { id; threadRootId; repoName; repoPath; task }): WorkerRecord`
  - `getWorker(id: string): WorkerRecord | undefined`
  - `getWorkerByThread(threadRootId: string): WorkerRecord | undefined`
  - `listWorkers(): WorkerRecord[]`
  - `updateWorker(id: string, patch: Partial<Pick<WorkerRecord,'sessionId'|'status'>>): void`
  - `addPendingQuestion(q: { id; workerId; questionPostId }): void`
  - `resolvePendingQuestion(id: string, answer: string): void`
  - `getOpenQuestionForWorker(workerId: string): { id: string; questionPostId: string } | undefined`
  - `setMeta(key: string, value: string): void` / `getMeta(key: string): string | undefined`
  - `close(): void`

- [ ] **Step 1: Write the failing test**

`tests/db.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Db } from '../src/db.js';

let db: Db;
beforeEach(() => { db = new Db(':memory:'); });

describe('Db', () => {
  it('creates and reads a worker by id and thread', () => {
    const w = db.createWorker({ id: 'w1', threadRootId: 't1', repoName: 'acme', repoPath: '/r/acme', task: 'do x' });
    expect(w.status).toBe('running');
    expect(db.getWorker('w1')?.task).toBe('do x');
    expect(db.getWorkerByThread('t1')?.id).toBe('w1');
  });

  it('updates session id and status', () => {
    db.createWorker({ id: 'w1', threadRootId: 't1', repoName: 'a', repoPath: '/a', task: 't' });
    db.updateWorker('w1', { sessionId: 's1', status: 'waiting' });
    const w = db.getWorker('w1')!;
    expect(w.sessionId).toBe('s1');
    expect(w.status).toBe('waiting');
  });

  it('tracks pending questions per worker', () => {
    db.createWorker({ id: 'w1', threadRootId: 't1', repoName: 'a', repoPath: '/a', task: 't' });
    db.addPendingQuestion({ id: 'q1', workerId: 'w1', questionPostId: 'p1' });
    expect(db.getOpenQuestionForWorker('w1')?.id).toBe('q1');
    db.resolvePendingQuestion('q1', 'the answer');
    expect(db.getOpenQuestionForWorker('w1')).toBeUndefined();
  });

  it('stores meta key/values', () => {
    db.setMeta('supervisor_session', 's-123');
    expect(db.getMeta('supervisor_session')).toBe('s-123');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL (`Db` not found).

- [ ] **Step 3: Implement `src/db.ts`**

```ts
import Database from 'better-sqlite3';
import type { WorkerRecord, WorkerStatus } from './types.js';

export class Db {
  private db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workers (
        id TEXT PRIMARY KEY,
        thread_root_id TEXT NOT NULL,
        repo_name TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        task TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workers_thread ON workers(thread_root_id);
      CREATE TABLE IF NOT EXISTS pending_questions (
        id TEXT PRIMARY KEY,
        worker_id TEXT NOT NULL,
        question_post_id TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0,
        answer TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pq_worker ON pending_questions(worker_id, resolved);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  private row(r: any): WorkerRecord {
    return {
      id: r.id, threadRootId: r.thread_root_id, repoName: r.repo_name, repoPath: r.repo_path,
      sessionId: r.session_id, status: r.status as WorkerStatus, task: r.task,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  createWorker(w: { id: string; threadRootId: string; repoName: string; repoPath: string; task: string }): WorkerRecord {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO workers (id, thread_root_id, repo_name, repo_path, session_id, status, task, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'running', ?, ?, ?)`
    ).run(w.id, w.threadRootId, w.repoName, w.repoPath, w.task, now, now);
    return this.getWorker(w.id)!;
  }

  getWorker(id: string): WorkerRecord | undefined {
    const r = this.db.prepare(`SELECT * FROM workers WHERE id = ?`).get(id);
    return r ? this.row(r) : undefined;
  }

  getWorkerByThread(threadRootId: string): WorkerRecord | undefined {
    const r = this.db.prepare(`SELECT * FROM workers WHERE thread_root_id = ?`).get(threadRootId);
    return r ? this.row(r) : undefined;
  }

  listWorkers(): WorkerRecord[] {
    return this.db.prepare(`SELECT * FROM workers ORDER BY created_at`).all().map((r) => this.row(r));
  }

  updateWorker(id: string, patch: Partial<Pick<WorkerRecord, 'sessionId' | 'status'>>): void {
    const cur = this.getWorker(id);
    if (!cur) return;
    const sessionId = patch.sessionId !== undefined ? patch.sessionId : cur.sessionId;
    const status = patch.status !== undefined ? patch.status : cur.status;
    this.db.prepare(`UPDATE workers SET session_id = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(sessionId, status, Date.now(), id);
  }

  addPendingQuestion(q: { id: string; workerId: string; questionPostId: string }): void {
    this.db.prepare(
      `INSERT INTO pending_questions (id, worker_id, question_post_id, resolved, created_at) VALUES (?, ?, ?, 0, ?)`
    ).run(q.id, q.workerId, q.questionPostId, Date.now());
  }

  resolvePendingQuestion(id: string, answer: string): void {
    this.db.prepare(`UPDATE pending_questions SET resolved = 1, answer = ? WHERE id = ?`).run(answer, id);
  }

  getOpenQuestionForWorker(workerId: string): { id: string; questionPostId: string } | undefined {
    const r = this.db.prepare(
      `SELECT id, question_post_id FROM pending_questions WHERE worker_id = ? AND resolved = 0 ORDER BY created_at DESC LIMIT 1`
    ).get(workerId) as any;
    return r ? { id: r.id, questionPostId: r.question_post_id } : undefined;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }
  getMeta(key: string): string | undefined {
    const r = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as any;
    return r?.value;
  }

  close(): void { this.db.close(); }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (stage; await approval)

```bash
git add src/db.ts tests/db.test.ts
git commit -m "feat: SQLite store for workers, questions, meta"
```

---

### Task 3: Mattermost pure helpers + gateway

**Files:**
- Create: `src/mattermost.ts`
- Test: `tests/mattermost.helpers.test.ts`

**Interfaces:**
- Consumes: `IncomingPost`, `Config`.
- Produces:
  - `normalizeIncomingPost(rawPost, botUserId): IncomingPost` — pure; `rawPost` is the parsed Mattermost `Post`.
  - `threadRootOf(post: { id: string; root_id: string }): string` — returns `post.root_id || post.id`.
  - `interface Gateway` (the interface the rest of the app depends on — enables fakes):
    - `getBotId(): string`
    - `connect(onPost: (p: IncomingPost) => void): Promise<void>`
    - `post(args: { text: string; threadRootId?: string; fileIds?: string[] }): Promise<string>` (returns created post id)
    - `uploadFile(filePath: string): Promise<string>` (returns file id)
    - `downloadFile(fileId: string, destPath: string): Promise<string>` (returns destPath)
    - `close(): void`
  - `class MattermostGateway implements Gateway` — real impl using `Client4` + `WebSocketClient`.

Only the pure helpers are unit-tested; `MattermostGateway`'s socket wiring is exercised in the manual smoke test (Task 11). The rest of the codebase depends on the `Gateway` **interface**, so tests inject fakes.

- [ ] **Step 1: Write the failing test**

`tests/mattermost.helpers.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { normalizeIncomingPost, threadRootOf } from '../src/mattermost.js';

describe('mattermost helpers', () => {
  it('threadRootOf returns root_id when present, else id', () => {
    expect(threadRootOf({ id: 'p1', root_id: '' })).toBe('p1');
    expect(threadRootOf({ id: 'p2', root_id: 'r1' })).toBe('r1');
  });

  it('normalizeIncomingPost maps fields and flags own posts', () => {
    const raw = { id: 'p1', channel_id: 'c1', root_id: '', message: 'hi', user_id: 'bot', file_ids: ['f1'] };
    const p = normalizeIncomingPost(raw as any, 'bot');
    expect(p).toEqual({ id: 'p1', channelId: 'c1', rootId: '', message: 'hi', userId: 'bot', fileIds: ['f1'], isOwn: true });
  });

  it('normalizeIncomingPost defaults missing file_ids to []', () => {
    const raw = { id: 'p2', channel_id: 'c1', root_id: 'r1', message: 'yo', user_id: 'u1' };
    const p = normalizeIncomingPost(raw as any, 'bot');
    expect(p.fileIds).toEqual([]);
    expect(p.isOwn).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mattermost.helpers.test.ts`
Expected: FAIL (module/exports missing).

- [ ] **Step 3: Implement `src/mattermost.ts`**

```ts
import { Client4, WebSocketClient } from '@mattermost/client';
import type { Post } from '@mattermost/types/posts';
import WebSocket from 'ws';
import { writeFile } from 'node:fs/promises';
import type { IncomingPost } from './types.js';
import type { Config } from './config.js';

export function threadRootOf(post: { id: string; root_id: string }): string {
  return post.root_id || post.id;
}

export function normalizeIncomingPost(raw: Post, botUserId: string): IncomingPost {
  return {
    id: raw.id,
    channelId: raw.channel_id,
    rootId: raw.root_id || '',
    message: raw.message,
    userId: raw.user_id,
    fileIds: raw.file_ids ?? [],
    isOwn: raw.user_id === botUserId,
  };
}

export interface Gateway {
  getBotId(): string;
  connect(onPost: (p: IncomingPost) => void): Promise<void>;
  post(args: { text: string; threadRootId?: string; fileIds?: string[] }): Promise<string>;
  uploadFile(filePath: string): Promise<string>;
  downloadFile(fileId: string, destPath: string): Promise<string>;
  close(): void;
}

export class MattermostGateway implements Gateway {
  private client = new Client4();
  private ws?: WebSocketClient;
  private botId = '';
  constructor(private cfg: Config['mattermost']) {
    this.client.setUrl(cfg.url);
    this.client.setToken(cfg.token);
  }

  getBotId(): string { return this.botId; }

  async connect(onPost: (p: IncomingPost) => void): Promise<void> {
    const me = await this.client.getMe();
    this.botId = me.id;

    const ws = new WebSocketClient({
      newWebSocketFn: (url: string) => new WebSocket(url) as any,
    } as any);
    this.ws = ws;
    ws.addMessageListener((msg: any) => {
      if (msg.event !== 'posted') return;
      if (msg.broadcast?.channel_id !== this.cfg.channelId) return;
      const raw = JSON.parse(msg.data.post as string) as Post;
      const p = normalizeIncomingPost(raw, this.botId);
      if (p.isOwn) return;
      onPost(p);
    });
    const wsUrl = this.cfg.url.replace(/^http/, 'ws') + '/api/v4/websocket';
    ws.initialize(wsUrl, this.cfg.token);
  }

  async post(args: { text: string; threadRootId?: string; fileIds?: string[] }): Promise<string> {
    const created = await this.client.createPost({
      channel_id: this.cfg.channelId,
      message: args.text,
      root_id: args.threadRootId ?? '',
      file_ids: args.fileIds,
    } as any);
    return created.id;
  }

  async uploadFile(filePath: string): Promise<string> {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const bytes = await readFile(filePath);
    const form = new FormData();
    form.append('channel_id', this.cfg.channelId);
    form.append('files', new Blob([bytes]), path.basename(filePath));
    const res = await this.client.uploadFile(form);
    return res.file_infos[0].id;
  }

  async downloadFile(fileId: string, destPath: string): Promise<string> {
    const url = this.client.getUrl() + this.client.getFileRoute(fileId);
    const resp = await fetch(url, { headers: { Authorization: `BEARER ${this.client.getToken()}` } });
    const bytes = Buffer.from(await resp.arrayBuffer());
    await writeFile(destPath, bytes);
    return destPath;
  }

  close(): void { this.ws?.close(); }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mattermost.helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (If `WebSocketClientConfig`/`uploadFile` signatures differ from the SDK's actual types, fix the call sites now — the research notes flagged `newWebSocketFn` and `uploadFile(form, isBookmark?)` as the spots to confirm.)

- [ ] **Step 6: Commit** (stage; await approval)

```bash
git add src/mattermost.ts tests/mattermost.helpers.test.ts
git commit -m "feat: Mattermost gateway and pure post helpers"
```

---

### Task 4: Pure message router

**Files:**
- Create: `src/router.ts`
- Test: `tests/router.test.ts`

**Interfaces:**
- Consumes: `IncomingPost`, `WorkerRecord`.
- Produces:
  - `type RouteAction = { kind: 'supervisor' } | { kind: 'resolve_question'; workerId: string } | { kind: 'inject_worker'; workerId: string }`
  - `interface RouterState { getWorkerByThread(threadRootId: string): WorkerRecord | undefined; hasOpenQuestion(workerId: string): boolean }`
  - `route(post: IncomingPost, state: RouterState): RouteAction`

Routing rules:
- Top-level post (`rootId === ''`) → `{ kind: 'supervisor' }`.
- Thread reply with a worker whose thread matches, and that worker has an open question → `resolve_question`.
- Thread reply with a matching worker but no open question → `inject_worker`.
- Thread reply with no matching worker → `{ kind: 'supervisor' }`.

- [ ] **Step 1: Write the failing test**

`tests/router.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { route, type RouterState } from '../src/router.js';
import type { IncomingPost, WorkerRecord } from '../src/types.js';

const post = (over: Partial<IncomingPost>): IncomingPost => ({
  id: 'p', channelId: 'c', rootId: '', message: 'm', userId: 'u', fileIds: [], isOwn: false, ...over,
});
const worker = (over: Partial<WorkerRecord>): WorkerRecord => ({
  id: 'w1', threadRootId: 't1', repoName: 'a', repoPath: '/a', sessionId: 's', status: 'running',
  task: 't', createdAt: 0, updatedAt: 0, ...over,
});

function state(worker: WorkerRecord | undefined, openQ: boolean): RouterState {
  return { getWorkerByThread: () => worker, hasOpenQuestion: () => openQ };
}

describe('route', () => {
  it('top-level post goes to supervisor', () => {
    expect(route(post({ rootId: '' }), state(undefined, false))).toEqual({ kind: 'supervisor' });
  });
  it('thread reply to a waiting worker resolves the question', () => {
    expect(route(post({ rootId: 't1' }), state(worker({}), true)))
      .toEqual({ kind: 'resolve_question', workerId: 'w1' });
  });
  it('thread reply to a running worker with no open question injects', () => {
    expect(route(post({ rootId: 't1' }), state(worker({}), false)))
      .toEqual({ kind: 'inject_worker', workerId: 'w1' });
  });
  it('thread reply with no worker goes to supervisor', () => {
    expect(route(post({ rootId: 'tX' }), state(undefined, false))).toEqual({ kind: 'supervisor' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/router.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/router.ts`**

```ts
import type { IncomingPost, WorkerRecord } from './types.js';

export type RouteAction =
  | { kind: 'supervisor' }
  | { kind: 'resolve_question'; workerId: string }
  | { kind: 'inject_worker'; workerId: string };

export interface RouterState {
  getWorkerByThread(threadRootId: string): WorkerRecord | undefined;
  hasOpenQuestion(workerId: string): boolean;
}

export function route(post: IncomingPost, state: RouterState): RouteAction {
  if (post.rootId === '') return { kind: 'supervisor' };
  const worker = state.getWorkerByThread(post.rootId);
  if (!worker) return { kind: 'supervisor' };
  if (state.hasOpenQuestion(worker.id)) return { kind: 'resolve_question', workerId: worker.id };
  return { kind: 'inject_worker', workerId: worker.id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/router.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (stage; await approval)

```bash
git add src/router.ts tests/router.test.ts
git commit -m "feat: pure message router"
```

---

### Task 5: ClaudeSession wrapper (streaming input + resume)

**Files:**
- Create: `src/session.ts`
- Test: `tests/session.test.ts`

**Interfaces:**
- Produces:
  - `type QueryFn = typeof import('@anthropic-ai/claude-agent-sdk').query`
  - `interface SessionOptions { cwd?: string; systemPromptAppend?: string; model?: string; mcpServers?: Record<string, unknown>; allowedTools?: string[]; disallowedTools?: string[]; env?: Record<string, string>; resume?: string }`
  - `class ClaudeSession`:
    - `constructor(queryFn: QueryFn, opts: SessionOptions, onSessionId?: (id: string) => void)`
    - `start(initialMessage: string): void` — begins the run loop.
    - `push(text: string): void` — enqueue a user message.
    - `stop(): void` — end the input stream.
    - `get sessionId(): string | undefined`

The wrapper injects `queryFn` so tests use a fake. It feeds `query()` an async-iterable backed by an internal queue, iterates the output stream in the background, and captures `session_id` from any output message that carries it.

- [ ] **Step 1: Write the failing test**

`tests/session.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { ClaudeSession } from '../src/session.js';

// A fake query() that echoes: records every user message it receives from the
// input iterable, and emits one result message carrying a session_id.
function makeFakeQuery(received: string[]) {
  return ((args: any) => {
    return (async function* () {
      const prompt = args.prompt as AsyncIterable<any>;
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      for await (const msg of prompt) {
        // documented shape: { type:'user', message:{ role:'user', content } }
        const content = msg.message?.content ?? msg.text;
        received.push(typeof content === 'string' ? content : JSON.stringify(content));
        yield { type: 'result', subtype: 'success', session_id: 'sess-1', result: 'ok' };
      }
    })();
  }) as any;
}

describe('ClaudeSession', () => {
  it('sends the initial message and captures the session id', async () => {
    const received: string[] = [];
    let capturedId: string | undefined;
    const s = new ClaudeSession(makeFakeQuery(received), {}, (id) => { capturedId = id; });
    s.start('hello');
    await vi.waitFor(() => expect(received).toContain('hello'));
    await vi.waitFor(() => expect(capturedId).toBe('sess-1'));
    expect(s.sessionId).toBe('sess-1');
  });

  it('push enqueues further messages into the same session', async () => {
    const received: string[] = [];
    const s = new ClaudeSession(makeFakeQuery(received), {}, () => {});
    s.start('first');
    await vi.waitFor(() => expect(received).toContain('first'));
    s.push('second');
    await vi.waitFor(() => expect(received).toContain('second'));
    s.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/session.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/session.ts`**

```ts
export type QueryFn = typeof import('@anthropic-ai/claude-agent-sdk').query;

export interface SessionOptions {
  cwd?: string;
  systemPromptAppend?: string;
  model?: string;
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  disallowedTools?: string[];
  env?: Record<string, string>;
  resume?: string;
}

// Minimal async queue: an async-iterable you can push to and close.
class MessageQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private resolvers: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;
  push(item: T): void {
    if (this.closed) return;
    const r = this.resolvers.shift();
    if (r) r({ value: item, done: false });
    else this.items.push(item);
  }
  close(): void {
    this.closed = true;
    let r; while ((r = this.resolvers.shift())) r({ value: undefined as any, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as any, done: true });
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

// NOTE: confirm this against the SDK's exported `SDKUserMessage` type during
// implementation; the SDK imports it, so `tsc` will flag a mismatch.
function userMessage(text: string): any {
  return { type: 'user', message: { role: 'user', content: text } };
}

export class ClaudeSession {
  private queue = new MessageQueue<any>();
  private _sessionId?: string;
  private running = false;
  constructor(
    private queryFn: QueryFn,
    private opts: SessionOptions,
    private onSessionId?: (id: string) => void,
  ) {}

  get sessionId(): string | undefined { return this._sessionId; }

  start(initialMessage: string): void {
    if (this.running) return;
    this.running = true;
    this.queue.push(userMessage(initialMessage));
    void this.runLoop();
  }

  push(text: string): void { this.queue.push(userMessage(text)); }
  stop(): void { this.queue.close(); this.running = false; }

  private async runLoop(): Promise<void> {
    const options: any = {
      permissionMode: 'bypassPermissions',
      cwd: this.opts.cwd,
      model: this.opts.model,
      mcpServers: this.opts.mcpServers,
      allowedTools: this.opts.allowedTools,
      disallowedTools: this.opts.disallowedTools,
      env: this.opts.env,
      resume: this.opts.resume,
    };
    if (this.opts.systemPromptAppend) {
      options.systemPrompt = { type: 'preset', preset: 'claude_code', append: this.opts.systemPromptAppend };
    }
    const stream = this.queryFn({ prompt: this.queue, options });
    for await (const msg of stream as AsyncIterable<any>) {
      if (msg?.session_id && !this._sessionId) {
        this._sessionId = msg.session_id;
        this.onSessionId?.(msg.session_id);
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/session.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check the SDK option shapes**

Run: `npx tsc --noEmit`
Expected: no errors. If `systemPrompt`, `permissionMode`, or `SDKUserMessage` shapes differ from the installed SDK, adjust `userMessage()` and `options` to match the SDK's exported types, then re-run tests.

- [ ] **Step 6: Commit** (stage; await approval)

```bash
git add src/session.ts tests/session.test.ts
git commit -m "feat: ClaudeSession streaming-input wrapper"
```

---

### Task 6: Pending-question registry

**Files:**
- Create: `src/pending.ts`
- Test: `tests/pending.test.ts`

**Interfaces:**
- Consumes: `Db`.
- Produces `class PendingQuestions`:
  - `constructor(db: Db)`
  - `ask(args: { workerId: string; questionPostId: string }): Promise<string>` — records the question (in-memory resolver + db row) and returns a Promise that resolves with the answer.
  - `resolve(workerId: string, answer: string): boolean` — resolves the worker's open question; returns whether one was pending.
  - `hasOpen(workerId: string): boolean`

Backs both the in-memory blocking Promise (so `ask_user` suspends) and the durable db row (so a reply after restart can still be matched). Uses `crypto.randomUUID()` for question ids.

- [ ] **Step 1: Write the failing test**

`tests/pending.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Db } from '../src/db.js';
import { PendingQuestions } from '../src/pending.js';

let db: Db; let pq: PendingQuestions;
beforeEach(() => {
  db = new Db(':memory:');
  db.createWorker({ id: 'w1', threadRootId: 't1', repoName: 'a', repoPath: '/a', task: 't' });
  pq = new PendingQuestions(db);
});

describe('PendingQuestions', () => {
  it('ask() blocks until resolve() supplies the answer', async () => {
    const p = pq.ask({ workerId: 'w1', questionPostId: 'p1' });
    expect(pq.hasOpen('w1')).toBe(true);
    const resolved = pq.resolve('w1', 'the answer');
    expect(resolved).toBe(true);
    await expect(p).resolves.toBe('the answer');
    expect(pq.hasOpen('w1')).toBe(false);
  });

  it('resolve() returns false when nothing is pending', () => {
    expect(pq.resolve('w1', 'x')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pending.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/pending.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';

export class PendingQuestions {
  private resolvers = new Map<string, { questionId: string; resolve: (answer: string) => void }>();
  constructor(private db: Db) {}

  ask(args: { workerId: string; questionPostId: string }): Promise<string> {
    const questionId = randomUUID();
    this.db.addPendingQuestion({ id: questionId, workerId: args.workerId, questionPostId: args.questionPostId });
    return new Promise<string>((resolve) => {
      this.resolvers.set(args.workerId, { questionId, resolve });
    });
  }

  resolve(workerId: string, answer: string): boolean {
    const entry = this.resolvers.get(workerId);
    const open = this.db.getOpenQuestionForWorker(workerId);
    if (!entry && !open) return false;
    if (open) this.db.resolvePendingQuestion(open.id, answer);
    if (entry) {
      this.resolvers.delete(workerId);
      entry.resolve(answer);
    }
    return true;
  }

  hasOpen(workerId: string): boolean {
    return this.resolvers.has(workerId) || this.db.getOpenQuestionForWorker(workerId) !== undefined;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/pending.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (stage; await approval)

```bash
git add src/pending.ts tests/pending.test.ts
git commit -m "feat: pending-question registry (blocking ask_user backend)"
```

---

### Task 7: Worker tools (`ask_user`, `send_update`, `finish`)

**Files:**
- Create: `src/tools/workerTools.ts`
- Test: `tests/workerTools.test.ts`

**Interfaces:**
- Consumes: `Gateway`, `Db`, `PendingQuestions`, and the SDK's `tool`/`createSdkMcpServer`.
- Produces:
  - `interface WorkerToolDeps { gateway: Gateway; db: Db; pending: PendingQuestions; workerId: string; threadRootId: string; onFinish: () => void }`
  - `createWorkerToolServer(deps: WorkerToolDeps): { server: unknown; toolNames: string[] }` — returns an in-process MCP server exposing `ask_user`, `send_update`, `finish`, plus the fully-qualified tool names (`mcp__worker__ask_user`, …) for `allowedTools`.

Tool behavior:
- `ask_user({ question })`: `postId = gateway.post({ text, threadRootId })`; set worker status `waiting`; `answer = await pending.ask({ workerId, questionPostId: postId })`; set status `running`; return the answer text.
- `send_update({ text, files? })`: for each file path, `uploadFile` → collect ids; `gateway.post({ text, threadRootId, fileIds })`; return confirmation.
- `finish({ summary })`: `gateway.post({ text: summary, threadRootId })`; set status `finished`; `onFinish()`; return confirmation.

Because directly instantiating the SDK MCP server is awkward to unit-test, factor the **handlers** into exported pure-ish functions and test those; the `createSdkMcpServer` wrapper is thin.

- [ ] **Step 1: Write the failing test**

`tests/workerTools.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Db } from '../src/db.js';
import { PendingQuestions } from '../src/pending.js';
import { askUserHandler, sendUpdateHandler, finishHandler, type WorkerToolDeps } from '../src/tools/workerTools.js';
import type { Gateway } from '../src/mattermost.js';

function fakeGateway(): Gateway & { posts: any[]; uploads: string[] } {
  const posts: any[] = []; const uploads: string[] = [];
  return {
    posts, uploads,
    getBotId: () => 'bot',
    connect: async () => {},
    post: async (a) => { posts.push(a); return 'post-' + posts.length; },
    uploadFile: async (p) => { uploads.push(p); return 'file-' + uploads.length; },
    downloadFile: async (_id, dest) => dest,
    close: () => {},
  };
}

let db: Db; let pending: PendingQuestions; let gateway: ReturnType<typeof fakeGateway>; let deps: WorkerToolDeps; let finished: boolean;
beforeEach(() => {
  db = new Db(':memory:');
  db.createWorker({ id: 'w1', threadRootId: 't1', repoName: 'a', repoPath: '/a', task: 't' });
  pending = new PendingQuestions(db);
  gateway = fakeGateway();
  finished = false;
  deps = { gateway, db, pending, workerId: 'w1', threadRootId: 't1', onFinish: () => { finished = true; } };
});

describe('worker tools', () => {
  it('ask_user posts the question, marks waiting, and blocks until answered', async () => {
    const p = askUserHandler(deps, { question: 'proceed?' });
    await vi.waitFor(() => expect(gateway.posts[0]).toMatchObject({ text: 'proceed?', threadRootId: 't1' }));
    expect(db.getWorker('w1')!.status).toBe('waiting');
    pending.resolve('w1', 'yes');
    const result = await p;
    expect(result.content[0].text).toContain('yes');
    expect(db.getWorker('w1')!.status).toBe('running');
  });

  it('send_update uploads files and posts with file ids', async () => {
    const res = await sendUpdateHandler(deps, { text: 'here is the plan', files: ['/tmp/plan.md'] });
    expect(gateway.uploads).toEqual(['/tmp/plan.md']);
    expect(gateway.posts[0]).toMatchObject({ text: 'here is the plan', threadRootId: 't1', fileIds: ['file-1'] });
    expect(res.content[0].text).toBeDefined();
  });

  it('finish posts the summary, marks finished, and calls onFinish', async () => {
    await finishHandler(deps, { summary: 'done' });
    expect(gateway.posts[0]).toMatchObject({ text: 'done', threadRootId: 't1' });
    expect(db.getWorker('w1')!.status).toBe('finished');
    expect(finished).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/workerTools.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/tools/workerTools.ts`**

```ts
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Gateway } from '../mattermost.js';
import type { Db } from '../db.js';
import type { PendingQuestions } from '../pending.js';

export interface WorkerToolDeps {
  gateway: Gateway;
  db: Db;
  pending: PendingQuestions;
  workerId: string;
  threadRootId: string;
  onFinish: () => void;
}

type ToolResult = { content: { type: 'text'; text: string }[] };
const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });

export async function askUserHandler(deps: WorkerToolDeps, args: { question: string }): Promise<ToolResult> {
  const postId = await deps.gateway.post({ text: args.question, threadRootId: deps.threadRootId });
  deps.db.updateWorker(deps.workerId, { status: 'waiting' });
  const answer = await deps.pending.ask({ workerId: deps.workerId, questionPostId: postId });
  deps.db.updateWorker(deps.workerId, { status: 'running' });
  return text(`The operator replied: ${answer}`);
}

export async function sendUpdateHandler(deps: WorkerToolDeps, args: { text: string; files?: string[] }): Promise<ToolResult> {
  const fileIds: string[] = [];
  for (const f of args.files ?? []) fileIds.push(await deps.gateway.uploadFile(f));
  await deps.gateway.post({ text: args.text, threadRootId: deps.threadRootId, fileIds: fileIds.length ? fileIds : undefined });
  return text('Update posted to the operator.');
}

export async function finishHandler(deps: WorkerToolDeps, args: { summary: string }): Promise<ToolResult> {
  await deps.gateway.post({ text: args.summary, threadRootId: deps.threadRootId });
  deps.db.updateWorker(deps.workerId, { status: 'finished' });
  deps.onFinish();
  return text('Marked finished.');
}

export function createWorkerToolServer(deps: WorkerToolDeps): { server: unknown; toolNames: string[] } {
  const server = createSdkMcpServer({
    name: 'worker',
    version: '1.0.0',
    tools: [
      tool('ask_user', 'Ask the human operator a question in this feature\'s thread and wait for their reply. Use whenever you need input, a decision, or clarification.',
        { question: z.string().describe('The question to ask the operator') },
        (a) => askUserHandler(deps, a)),
      tool('send_update', 'Post a progress update to the operator, optionally attaching files (specs, plans, diffs). Use to share artifacts or status.',
        { text: z.string(), files: z.array(z.string()).optional().describe('Absolute file paths to attach') },
        (a) => sendUpdateHandler(deps, a)),
      tool('finish', 'Post a final summary and mark this feature complete.',
        { summary: z.string() },
        (a) => finishHandler(deps, a)),
    ],
  });
  return { server, toolNames: ['mcp__worker__ask_user', 'mcp__worker__send_update', 'mcp__worker__finish'] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/workerTools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (stage; await approval)

```bash
git add src/tools/workerTools.ts tests/workerTools.test.ts
git commit -m "feat: worker tools (ask_user, send_update, finish)"
```

---

### Task 8: Worker class

**Files:**
- Create: `src/worker.ts`
- Test: `tests/worker.test.ts`

**Interfaces:**
- Consumes: `ClaudeSession`, `QueryFn`, `createWorkerToolServer`, `Gateway`, `Db`, `PendingQuestions`, `Config`.
- Produces `class Worker`:
  - `constructor(deps: { queryFn: QueryFn; gateway: Gateway; db: Db; pending: PendingQuestions; cfg: Config; record: WorkerRecord; onFinish: () => void })`
  - `start(): void` — builds the worker MCP server, constructs a `ClaudeSession` (cwd = repo path, `env.MCP_TIMEOUT`, allowed tools = default coding tools + worker MCP tool names, append worker system prompt), persists the session id to the db, and starts the session with the task as the initial message.
  - `startResumed(): void` — same but passes `resume: record.sessionId` and no initial message beyond a nudge.
  - `inject(text: string, filePaths: string[]): void` — pushes a message (with any downloaded attachment paths appended) into the session.
  - `get id(): string`

The worker's appended system prompt (a constant `WORKER_SYSTEM_PROMPT`) tells it: it is an autonomous worker on a single feature; the ONLY way to reach the human is the `ask_user` / `send_update` / `finish` tools; work autonomously and call `finish` when done.

- [ ] **Step 1: Write the failing test**

`tests/worker.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/worker.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/worker.ts`**

```ts
import { ClaudeSession, type QueryFn } from './session.js';
import { createWorkerToolServer } from './tools/workerTools.js';
import { PendingQuestions } from './pending.js';
import type { Gateway } from './mattermost.js';
import type { Db } from './db.js';
import type { Config } from './config.js';
import type { WorkerRecord } from './types.js';

export const WORKER_SYSTEM_PROMPT = `You are an autonomous engineering worker assigned to ONE feature in this repository.
The human operator is NOT watching your terminal. The ONLY way to communicate with them is via your tools:
- ask_user: ask a question and wait for the reply (use whenever you need a decision, clarification, or input).
- send_update: post progress or share an artifact (spec, plan, diff) as an attachment.
- finish: post a final summary when the feature is complete.
Work autonomously. Decide for yourself when you need the operator. When done, call finish.`;

export interface WorkerDeps {
  queryFn: QueryFn;
  gateway: Gateway;
  db: Db;
  pending: PendingQuestions;
  cfg: Config;
  record: WorkerRecord;
  onFinish: () => void;
}

export class Worker {
  private session!: ClaudeSession;
  constructor(private deps: WorkerDeps) {}

  get id(): string { return this.deps.record.id; }

  private buildSession(resume?: string): ClaudeSession {
    const { server, toolNames } = createWorkerToolServer({
      gateway: this.deps.gateway, db: this.deps.db, pending: this.deps.pending,
      workerId: this.deps.record.id, threadRootId: this.deps.record.threadRootId,
      onFinish: this.deps.onFinish,
    });
    return new ClaudeSession(
      this.deps.queryFn,
      {
        cwd: this.deps.record.repoPath,
        systemPromptAppend: WORKER_SYSTEM_PROMPT,
        model: this.deps.cfg.model,
        mcpServers: { worker: server },
        allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', ...toolNames],
        env: { ...process.env as Record<string, string>, MCP_TIMEOUT: String(this.deps.cfg.askUserTimeoutMs) },
        resume,
      },
      (id) => this.deps.db.updateWorker(this.deps.record.id, { sessionId: id }),
    );
  }

  start(): void {
    this.session = this.buildSession();
    this.session.start(this.deps.record.task);
  }

  startResumed(): void {
    this.session = this.buildSession(this.deps.record.sessionId ?? undefined);
    this.session.start('You were reconnected after a restart. Continue where you left off.');
  }

  inject(text: string, filePaths: string[]): void {
    const suffix = filePaths.length ? `\n\nAttached files (local paths):\n${filePaths.join('\n')}` : '';
    this.session.push(text + suffix);
  }

  stop(): void { this.session?.stop(); }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/worker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (stage; await approval)

```bash
git add src/worker.ts tests/worker.test.ts
git commit -m "feat: Worker session composition"
```

---

### Task 9: Supervisor tools + Supervisor class

**Files:**
- Create: `src/tools/supervisorTools.ts`, `src/supervisor.ts`
- Test: `tests/supervisorTools.test.ts`

**Interfaces:**
- Consumes: `Gateway`, `Db`, `Config`, `ClaudeSession`, `QueryFn`, and a `spawnWorker` callback provided by the Bridge (Task 10) — the tool doesn't create `Worker` objects itself; it calls back into the Bridge so the Bridge owns lifecycle/concurrency.
- Produces:
  - `interface SupervisorToolDeps { gateway: Gateway; db: Db; cfg: Config; spawnWorker(args: { repo: string; task: string; threadRootId: string }): { ok: true; workerId: string } | { ok: false; reason: string }; stopWorker(workerId: string): void }`
  - Exported handlers: `listReposHandler`, `spawnWorkerHandler`, `listWorkersHandler`, `postToChannelHandler`, `stopWorkerHandler`.
  - `createSupervisorToolServer(deps): { server: unknown; toolNames: string[] }`
  - `class Supervisor` with `constructor(deps: { queryFn; gateway; db; cfg; toolServer })`, `start(seed: string): void`, `startResumed(sessionId: string): void`, `push(text: string): void`.

- [ ] **Step 1: Write the failing test**

`tests/supervisorTools.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/supervisorTools.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/tools/supervisorTools.ts`**

```ts
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Gateway } from '../mattermost.js';
import type { Db } from '../db.js';
import type { Config } from '../config.js';

export interface SupervisorToolDeps {
  gateway: Gateway;
  db: Db;
  cfg: Config;
  spawnWorker(args: { repo: string; task: string; threadRootId: string }): { ok: true; workerId: string } | { ok: false; reason: string };
  stopWorker(workerId: string): void;
}

type ToolResult = { content: { type: 'text'; text: string }[] };
const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });

export async function listReposHandler(deps: SupervisorToolDeps, _args: {}): Promise<ToolResult> {
  const lines = Object.entries(deps.cfg.repos).map(([name, r]) => `- ${name}: ${r.description} (${r.path})`);
  return text(`Available repositories:\n${lines.join('\n')}`);
}

export async function spawnWorkerHandler(deps: SupervisorToolDeps, args: { repo: string; task: string; threadRootId: string }): Promise<ToolResult> {
  if (!deps.cfg.repos[args.repo]) {
    return text(`Unknown repo "${args.repo}". Known repos: ${Object.keys(deps.cfg.repos).join(', ')}. Ask the operator which one to use.`);
  }
  const r = deps.spawnWorker(args);
  return r.ok ? text(`Spawned worker ${r.workerId} in ${args.repo}.`) : text(`Could not spawn worker: ${r.reason}`);
}

export async function listWorkersHandler(deps: SupervisorToolDeps, _args: {}): Promise<ToolResult> {
  const workers = deps.db.listWorkers();
  if (!workers.length) return text('No workers.');
  const lines = workers.map((w) => `- ${w.id} [${w.status}] repo=${w.repoName} thread=${w.threadRootId} task="${w.task}"`);
  return text(lines.join('\n'));
}

export async function postToChannelHandler(deps: SupervisorToolDeps, args: { text: string; threadRootId?: string }): Promise<ToolResult> {
  await deps.gateway.post({ text: args.text, threadRootId: args.threadRootId });
  return text('Posted.');
}

export async function stopWorkerHandler(deps: SupervisorToolDeps, args: { workerId: string }): Promise<ToolResult> {
  deps.stopWorker(args.workerId);
  return text(`Stopped worker ${args.workerId}.`);
}

export function createSupervisorToolServer(deps: SupervisorToolDeps): { server: unknown; toolNames: string[] } {
  const server = createSdkMcpServer({
    name: 'supervisor',
    version: '1.0.0',
    tools: [
      tool('list_repos', 'List the repositories you can spawn workers in.', {}, (a) => listReposHandler(deps, a)),
      tool('spawn_worker', 'Start a worker on a feature in a repository. Provide the repo registry name, the task, and the thread root id you were given.',
        { repo: z.string(), task: z.string(), threadRootId: z.string() }, (a) => spawnWorkerHandler(deps, a)),
      tool('list_workers', 'List current workers and their status.', {}, (a) => listWorkersHandler(deps, a)),
      tool('post_to_channel', 'Post a message to the operator (channel-level, or into a thread if threadRootId is given).',
        { text: z.string(), threadRootId: z.string().optional() }, (a) => postToChannelHandler(deps, a)),
      tool('stop_worker', 'Terminate a worker.', { workerId: z.string() }, (a) => stopWorkerHandler(deps, a)),
    ],
  });
  return {
    server,
    toolNames: ['mcp__supervisor__list_repos', 'mcp__supervisor__spawn_worker', 'mcp__supervisor__list_workers', 'mcp__supervisor__post_to_channel', 'mcp__supervisor__stop_worker'],
  };
}
```

- [ ] **Step 4: Implement `src/supervisor.ts`**

```ts
import { ClaudeSession, type QueryFn } from './session.js';
import type { Gateway } from './mattermost.js';
import type { Db } from './db.js';
import type { Config } from './config.js';

export function supervisorSystemPrompt(cfg: Config): string {
  const repos = Object.entries(cfg.repos).map(([n, r]) => `- ${n}: ${r.description}`).join('\n');
  return `You are the Supervisor: an orchestrator for engineering workers, reachable through one Mattermost channel.
You do NOT write code yourself. Your job:
- A top-level channel message is either a new feature request or a command (status, stop, etc.).
- For a feature request: identify which repository it targets from this registry:
${repos}
  If it is clear, call spawn_worker with the repo name, the task, and the thread root id given to you in the message. If the repo is missing or ambiguous, call post_to_channel to ask the operator (in the same thread) which repo to use — never guess.
- For commands: use list_workers / stop_worker and reply with post_to_channel.
Each message you receive tells you the Mattermost thread root id to act on. Always pass it through.`;
}

export interface SupervisorDeps {
  queryFn: QueryFn;
  db: Db;
  cfg: Config;
  toolServer: { server: unknown; toolNames: string[] };
}

export class Supervisor {
  private session: ClaudeSession;
  constructor(private deps: SupervisorDeps) {
    this.session = new ClaudeSession(
      deps.queryFn,
      {
        systemPromptAppend: supervisorSystemPrompt(deps.cfg),
        model: deps.cfg.model,
        mcpServers: { supervisor: deps.toolServer.server },
        allowedTools: deps.toolServer.toolNames,
        disallowedTools: ['Bash', 'Write', 'Edit'],
        resume: deps.db.getMeta('supervisor_session') ?? undefined,
      },
      (id) => deps.db.setMeta('supervisor_session', id),
    );
  }
  start(seed: string): void { this.session.start(seed); }
  push(text: string): void { this.session.push(text); }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/supervisorTools.test.ts && npx tsc --noEmit`
Expected: PASS and clean type-check.

- [ ] **Step 6: Commit** (stage; await approval)

```bash
git add src/tools/supervisorTools.ts src/supervisor.ts tests/supervisorTools.test.ts
git commit -m "feat: supervisor tools and Supervisor session"
```

---

### Task 10: Bridge (wiring, routing dispatch, reconciliation)

**Files:**
- Create: `src/bridge.ts`
- Test: `tests/bridge.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces `class Bridge`:
  - `constructor(deps: { queryFn: QueryFn; gateway: Gateway; db: Db; cfg: Config })`
  - `async start(): Promise<void>` — connect the gateway with `onPost = this.handlePost`, reconcile persisted workers, start (or resume) the Supervisor.
  - `handlePost(post: IncomingPost): Promise<void>` — download any attachments, `route(...)`, dispatch: `supervisor` → format a message (including the thread root id) and `supervisor.push`; `resolve_question` → download attachments, `pending.resolve(workerId, answerText)`; `inject_worker` → `worker.inject`.
  - internal `spawnWorker(...)`, `stopWorker(...)` passed into the supervisor tool deps; enforce `workerConcurrency`.

`spawnWorker`: reject if active workers ≥ `workerConcurrency`; else `db.createWorker`, build a `Worker`, `worker.start()`, track it in an in-memory `Map<string, Worker>`; post an acknowledgement into the thread.

- [ ] **Step 1: Write the failing test**

`tests/bridge.test.ts`:
```ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bridge.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/bridge.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { route } from './router.js';
import { PendingQuestions } from './pending.js';
import { Worker } from './worker.js';
import { Supervisor } from './supervisor.js';
import { createSupervisorToolServer, type SupervisorToolDeps } from './tools/supervisorTools.js';
import type { QueryFn } from './session.js';
import type { Gateway } from './mattermost.js';
import type { Db } from './db.js';
import type { Config } from './config.js';
import type { IncomingPost } from './types.js';

export interface BridgeDeps { queryFn: QueryFn; gateway: Gateway; db: Db; cfg: Config }

export class Bridge {
  private pending: PendingQuestions;
  private workers = new Map<string, Worker>();
  private supervisor!: Supervisor;
  constructor(private deps: BridgeDeps) {
    this.pending = new PendingQuestions(deps.db);
  }

  async start(): Promise<void> {
    await mkdir(this.deps.cfg.attachmentDir, { recursive: true });
    await this.deps.gateway.connect((p) => { void this.handlePost(p); });

    // Reconcile persisted workers.
    for (const rec of this.deps.db.listWorkers()) {
      if (rec.status === 'finished' || rec.status === 'failed') continue;
      if (!rec.sessionId) { this.markFailed(rec.id, 'No session to resume.'); continue; }
      const worker = new Worker({
        queryFn: this.deps.queryFn, gateway: this.deps.gateway, db: this.deps.db,
        pending: this.pending, cfg: this.deps.cfg, record: rec, onFinish: () => this.workers.delete(rec.id),
      });
      try { worker.startResumed(); this.workers.set(rec.id, worker); }
      catch { this.markFailed(rec.id, 'Could not resume session.'); }
    }

    // Start / resume the supervisor.
    const toolServer = createSupervisorToolServer(this.supervisorDeps());
    this.supervisor = new Supervisor({ queryFn: this.deps.queryFn, db: this.deps.db, cfg: this.deps.cfg, toolServer });
    const active = this.deps.db.listWorkers().filter((w) => w.status === 'running' || w.status === 'waiting');
    this.supervisor.start(`You are online. Active workers: ${active.length ? active.map((w) => `${w.id}(${w.repoName})`).join(', ') : 'none'}.`);
  }

  private supervisorDeps(): SupervisorToolDeps {
    return {
      gateway: this.deps.gateway, db: this.deps.db, cfg: this.deps.cfg,
      spawnWorker: (a) => this.spawnWorker(a),
      stopWorker: (id) => this.stopWorker(id),
    };
  }

  private spawnWorker(args: { repo: string; task: string; threadRootId: string }): { ok: true; workerId: string } | { ok: false; reason: string } {
    const repo = this.deps.cfg.repos[args.repo];
    if (!repo) return { ok: false, reason: `Unknown repo ${args.repo}` };
    const active = [...this.workers.values()].length;
    if (active >= this.deps.cfg.workerConcurrency) return { ok: false, reason: 'Concurrency limit reached' };

    const id = 'w-' + randomUUID().slice(0, 8);
    const rec = this.deps.db.createWorker({ id, threadRootId: args.threadRootId, repoName: args.repo, repoPath: repo.path, task: args.task });
    const worker = new Worker({
      queryFn: this.deps.queryFn, gateway: this.deps.gateway, db: this.deps.db,
      pending: this.pending, cfg: this.deps.cfg, record: rec, onFinish: () => this.workers.delete(id),
    });
    worker.start();
    this.workers.set(id, worker);
    void this.deps.gateway.post({ text: `Started a worker in **${args.repo}** for this feature.`, threadRootId: args.threadRootId });
    return { ok: true, workerId: id };
  }

  private stopWorker(id: string): void {
    this.workers.get(id)?.stop();
    this.workers.delete(id);
    this.deps.db.updateWorker(id, { status: 'finished' });
  }

  private markFailed(id: string, reason: string): void {
    this.deps.db.updateWorker(id, { status: 'failed' });
    const rec = this.deps.db.getWorker(id);
    if (rec) void this.deps.gateway.post({ text: `Worker could not be restored: ${reason}`, threadRootId: rec.threadRootId });
  }

  private async downloadAttachments(post: IncomingPost): Promise<string[]> {
    const out: string[] = [];
    for (const fid of post.fileIds) {
      const dest = path.join(this.deps.cfg.attachmentDir, `${post.id}-${fid}`);
      out.push(await this.deps.gateway.downloadFile(fid, dest));
    }
    return out;
  }

  async handlePost(post: IncomingPost): Promise<void> {
    const files = post.fileIds.length ? await this.downloadAttachments(post) : [];
    const action = route(post, {
      getWorkerByThread: (t) => this.deps.db.getWorkerByThread(t),
      hasOpenQuestion: (wid) => this.pending.hasOpen(wid),
    });

    if (action.kind === 'supervisor') {
      const attach = files.length ? `\nAttached files: ${files.join(', ')}` : '';
      const kind = post.rootId === '' ? 'New top-level message' : 'Thread message (no worker)';
      this.supervisor.push(`${kind} in thread ${post.rootId || post.id} from the operator:\n"${post.message}"${attach}`);
      return;
    }
    if (action.kind === 'resolve_question') {
      const answer = files.length ? `${post.message}\nAttached files:\n${files.join('\n')}` : post.message;
      this.pending.resolve(action.workerId, answer);
      return;
    }
    if (action.kind === 'inject_worker') {
      this.workers.get(action.workerId)?.inject(post.message, files);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/bridge.test.ts && npx tsc --noEmit`
Expected: PASS and clean type-check.

- [ ] **Step 5: Commit** (stage; await approval)

```bash
git add src/bridge.ts tests/bridge.test.ts
git commit -m "feat: Bridge wiring, routing dispatch, reconciliation"
```

---

### Task 11: Entrypoint + full test run + manual smoke test

**Files:**
- Create: `src/index.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: `loadConfig`, `Db`, `MattermostGateway`, `Bridge`, and the real `query` from the SDK.

- [ ] **Step 1: Implement `src/index.ts`**

```ts
import 'dotenv/config';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { MattermostGateway } from './mattermost.js';
import { Bridge } from './bridge.js';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

async function main() {
  const cfg = loadConfig(process.env, process.env.REPOS_JSON ?? '{}');
  await mkdir(path.dirname(cfg.dbPath), { recursive: true });
  const db = new Db(cfg.dbPath);
  const gateway = new MattermostGateway(cfg.mattermost);
  const bridge = new Bridge({ queryFn: query, gateway, db, cfg });
  await bridge.start();
  console.log('Supervisor bridge online.');

  const shutdown = () => { gateway.close(); db.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Add scripts to `package.json`**

```bash
npm pkg set scripts.dev="tsx src/index.ts"
npm pkg set scripts.test="vitest run"
npm pkg set scripts.typecheck="tsc --noEmit"
```

- [ ] **Step 3: Run the full test suite + type-check**

Run: `npm run test && npm run typecheck`
Expected: all tests PASS, no type errors.

- [ ] **Step 4: Manual smoke test (operator, real Mattermost + real repo)**

Populate `.env` from `.env.example` with a real bot token, channel id, and at least one repo. Then:

```bash
npm run dev
```

In the Mattermost channel, post: `In <repo-name>, add a trivial README note.` Verify: the bot posts an acknowledgement in a new thread; a worker starts in the repo; the worker either asks a question (reply in the thread and confirm it resumes) or posts an update/finish. Attach a file in the thread and confirm the worker references it. Stop with Ctrl-C; restart `npm run dev` and confirm active workers are reconciled (or a failure notice is posted).

This step validates the real `MattermostGateway` socket wiring and the real SDK session behavior that the unit tests fake. If the WebSocket doesn't connect, check the `newWebSocketFn`/`CloseEvent` notes in the research and Global Constraints.

- [ ] **Step 5: Commit** (stage; await approval)

```bash
git add src/index.ts package.json
git commit -m "feat: entrypoint and runtime wiring"
```

---

### Task 12: End-to-end integration test (fakes for SDK + gateway, real everything else)

**Files:**
- Create: `tests/integration.test.ts`

**Interfaces:**
- Consumes: real `Bridge`, `Db`, `router`, tools, `PendingQuestions`; a **scripted fake `query`** that drives a worker through `ask_user` → `send_update` → `finish` by invoking the MCP tool handlers the SDK would call, and a fake `Gateway` capturing posts/uploads.

Because the fake `query` cannot actually execute MCP tools the way the real SDK does, this test drives the tool handlers directly via the Bridge's public surface to assert the full path: top-level post → supervisor spawn callback → worker started → worker asks → operator reply resolves → worker sends an artifact → finishes. This is the integration seam that unit tests cover in isolation, now exercised together against a real `Db`.

- [ ] **Step 1: Write the integration test**

`tests/integration.test.ts`:
```ts
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
    downloadFile: async (_i, d) => d, close: () => {},
  };
}
const queryFn = ((args: any) => (async function* () {
  yield { type: 'system', session_id: 's' };
  for await (const _m of args.prompt) { /* drain */ }
})()) as any;

const cfg = {
  repos: { acme: { path: process.cwd(), description: 'API' } },
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
    const deps = { gateway: (bridge as any).deps.gateway, db, pending, workerId: worker.id, threadRootId: 'root1', onFinish: () => {} };

    // 3. Worker asks a question (blocks).
    const asked = askUserHandler(deps, { question: 'Which file?' });
    await vi.waitFor(() => expect(posts.some((p) => p.text === 'Which file?')).toBe(true));
    expect(db.getWorker(worker.id)!.status).toBe('waiting');

    // 4. Operator replies in the thread -> resolves the question.
    await bridge.handlePost(post({ id: 'r1', rootId: 'root1', message: 'README.md' }));
    await expect(asked).resolves.toMatchObject({ content: [{ text: expect.stringContaining('README.md') }] });
    expect(db.getWorker(worker.id)!.status).toBe('running');

    // 5. Worker sends an artifact, then finishes.
    await sendUpdateHandler(deps, { text: 'Here is the diff', files: ['/scratch/change.diff'] });
    expect(uploads).toContain('/scratch/change.diff');
    await finishHandler(deps, { summary: 'Done: added the note.' });
    expect(db.getWorker(worker.id)!.status).toBe('finished');
    expect(posts.some((p) => p.text === 'Done: added the note.')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run tests/integration.test.ts`
Expected: PASS.

- [ ] **Step 3: Run the complete suite**

Run: `npm run test && npm run typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 4: Commit** (stage; await approval)

```bash
git add tests/integration.test.ts
git commit -m "test: end-to-end feature flow integration"
```

---

## Self-Review

**Spec coverage:**
- One channel / one bot / persistent supervisor → Task 9 (`Supervisor`, session resume via `meta`), Task 3 (gateway), Task 10 (start).
- Always-continue via auto-compaction → built into the SDK; Global Constraints + Task 5 note.
- Workers in local repos, autonomous → Task 8 (`cwd`, `bypassPermissions`, allowed coding tools + worker prompt).
- Pause for input (blocking `ask_user`) → Tasks 6, 7 (+ MCP_TIMEOUT in Task 8).
- Artifacts as attachments (outbound) → Task 7 `send_update`; (inbound) → Task 3 `downloadFile`, Task 10 attachment download + inject/resolve.
- Thread-per-feature + routing → Tasks 3, 4, 10.
- Multiple repos via registry → Tasks 1, 9 (`list_repos`, prompt), 10 (`spawnWorker` resolution).
- SQLite durable state + restart reconciliation → Tasks 2, 10.
- Error handling (crash/failed, reconnect, unanswered ask) → Task 10 (`markFailed`), Task 3 (built-in WS reconnect), Task 6 (indefinite wait bounded by `MCP_TIMEOUT`).
- Testing (unit + integration) → Tasks 1–10 unit, Task 12 integration, Task 11 manual smoke.
- Config → Task 1.

**Placeholder scan:** No `TBD`/`TODO`/"handle edge cases" placeholders; every code step has real code. The two flagged SDK-shape confirmations (Task 5 `SDKUserMessage`/`systemPrompt`, Task 3 `newWebSocketFn`/`uploadFile`) are concrete verification steps with expected shapes and a stated fix path, not deferred work.

**Type consistency:** `Gateway`, `WorkerRecord`, `IncomingPost`, `RouteAction`, `SessionOptions`, `WorkerToolDeps`, `SupervisorToolDeps`, and tool-name arrays (`mcp__worker__*`, `mcp__supervisor__*`) are used consistently across tasks. `spawnWorker`'s return shape (`{ ok; workerId } | { ok; reason }`) matches between Task 9 (consumer) and Task 10 (producer). `ClaudeSession` API (`start`/`push`/`stop`/`sessionId`) matches its consumers in Tasks 8–9.

## Notes & risks for the executor

- **`ask_user` timeout:** the SDK's default 30 s MCP tool timeout is overridden per worker via `env.MCP_TIMEOUT` (24 h default). If a worker legitimately needs to wait longer than the configured value, the tool call will error; the worker should re-ask. Tune `ASK_USER_TIMEOUT_MS` if needed.
- **SDK shape confirmations** (Tasks 3 & 5) are the highest-risk spots — do them against the installed package's `.d.ts`, not from memory.
- The manual smoke test (Task 11) is the only place the real WebSocket and real SDK sessions run end to end; treat a green unit suite as necessary but not sufficient.
