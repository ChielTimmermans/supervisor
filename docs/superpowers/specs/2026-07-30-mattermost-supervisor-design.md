# Mattermost Supervisor — Design

**Date:** 2026-07-30
**Status:** Approved design, pending implementation plan

## Summary

A personal orchestration system that gives Claude Code a chat interface through
Mattermost. You post a feature request in a Mattermost channel; a **Supervisor**
(a persistent Claude Code session) spins up a **Worker** (another Claude Code
session) in the target repository. The worker runs autonomously and talks back
to you — asking questions and sending artifacts (specs, plans, diffs) — whenever
it judges it needs to. Each feature lives in its own Mattermost thread.

Everything runs locally on the devbox. Mattermost is self-hosted.

## Goals

- One always-on interface: a single Mattermost channel, a single bot identity.
- A persistent Supervisor that never dies from context exhaustion.
- Workers that do real coding work in local repositories and pause for human
  input mid-task, resuming when answered.
- Artifacts (specs, plans, diffs, files) delivered as Mattermost attachments,
  and files the operator attaches in a thread handed to the worker.
- Related messages kept together in threads — one thread per feature.
- Support for multiple target repositories, selected per request.

## Non-goals

- No web UI or dashboard — Mattermost is the entire interface.
- No hosted/cloud execution — all sessions run on the devbox.
- No fixed superpowers checkpoint gates — workers decide when to involve the
  human. (Superpowers skills are still available to workers; they just aren't
  forced into a rigid brainstorm → plan → implement gate by the supervisor.)
- No multi-user access control — this is a single-operator tool on the operator's
  own machine.

## Architecture

Three layers, all local:

```
        Mattermost (self-hosted, 1 channel, 1 bot account)
                          │  WebSocket + REST
                          ▼
   ┌──────────────────────────────────────────────────────┐
   │  BRIDGE  (Node/TypeScript, no LLM — the only always-  │
   │          on process)                                  │
   │   • Mattermost client (WS events + REST posts/files)  │
   │   • SQLite durable state                              │
   │   • Session manager (spawns/tracks Claude sessions)   │
   │   • In-process MCP tools for supervisor & workers     │
   └───────────────┬───────────────────────┬──────────────┘
                   │ Agent SDK             │ Agent SDK
                   ▼                       ▼
        ┌────────────────────┐   ┌────────────────────────┐
        │ SUPERVISOR         │   │ WORKER (one per feature)│
        │ Claude Code session│   │ Claude Code session     │
        │ persistent,        │   │ cwd = target repo       │
        │ auto-compacting    │   │ full toolset + skills   │
        │ orchestration only │   │ auto-compacting         │
        │ tools: spawn_worker│   │ tools: ask_user,        │
        │  list_workers,     │   │  send_update, finish    │
        │  list_repos,       │   │                         │
        │  post_to_channel,  │   │                         │
        │  stop_worker       │   │                         │
        └────────────────────┘   └────────────────────────┘
```

### The Bridge

A plain TypeScript service with no LLM of its own. It is the only always-on
process and the single source of truth. Responsibilities:

- **Mattermost connectivity:** one bot account. Holds the WebSocket for inbound
  events (posts) and uses REST for outbound posts and file uploads. Reconnects
  with backoff; queues outbound posts while disconnected.
- **Session management:** starts and tracks the Supervisor session and one Worker
  session per active feature, using the **Claude Agent SDK (TypeScript)**. Sets
  each worker's working directory to the resolved repository path.
- **Custom tools:** hosts the in-process MCP tools that the supervisor and
  workers call (see Tools below). This is where `ask_user` blocking, message
  routing, and Mattermost posting actually happen.
- **State:** owns the SQLite store (see State & Persistence).

### The Supervisor

One persistent Claude Code session driven by the Bridge through the Agent SDK.
It relies on Claude Code's **native auto-compaction** to run indefinitely — this
is what satisfies the "always continue" requirement, with no hand-rolled context
management. The supervisor does **not** write code; it orchestrates. It handles
top-level channel posts, decides whether a post is a new feature or a
meta/status request, resolves which repository a feature targets, and spawns
workers.

### Workers

One Claude Code session per feature, with `cwd` set to the target repository and
the **full Claude Code toolset plus the operator's superpowers skills**. Each
worker is also an Agent SDK session and auto-compacts on long-running features.
Workers run autonomously and reach back to the human only through their
talk-back tools.

## Message & Threading Model

One channel, one bot. Threads disambiguate who is speaking:

- **Top-level post in the channel → the Supervisor.** It classifies the post:
  - A new feature request → resolve the repo, then `spawn_worker`. The post's
    root becomes that worker's thread.
  - A meta/status request ("what's running?", "stop the auth worker") → answer
    via `post_to_channel` / act via `list_workers` / `stop_worker`.
- **Reply inside a thread → that thread's Worker.**
  - If the worker is blocked on an `ask_user` call, the reply **resolves** it and
    the worker resumes.
  - If the worker is running (not blocked), the reply is **injected** as a new
    user message into that worker's session.
  - If the thread has no associated worker, the reply routes to the Supervisor.
- **Attachments on a thread reply** are downloaded by the Bridge to a local
  scratch path and their paths are included with the routed message (either as
  the resolved `ask_user` answer or the injected message), so the worker can read
  the file directly.

All of a worker's questions and updates are posted **into its own thread**, in
the worker's own words. Because there is a single bot identity, the operator sees
one assistant, cleanly threaded per feature.

## Human-in-the-loop Mechanism

`ask_user` is an MCP tool hosted by the Bridge. Flow:

1. A worker calls `ask_user({ question })`.
2. The Bridge posts the question into the worker's thread and records a row in
   `pending_questions`. It **holds the tool call open** — the worker's turn
   suspends inside the call.
3. The operator replies in that thread.
4. The Bridge matches the reply to the pending question, resolves the held tool
   call with the reply text, and marks the question resolved. The worker resumes
   with the answer as the tool result.

There is no polling and no fixed checkpoint schedule. Workers ask whenever they
judge they need input.

## Repository Resolution

- The Bridge config holds a **repo registry**: `name → absolute path on the
  devbox` (e.g. `acme-api → /Users/chiel/projects/acme-api`).
- The registry is summarized in the Supervisor's system prompt and available live
  via a `list_repos` tool, so adding a repo is a config change requiring no
  prompt edits.
- The operator names the repo in the feature request ("In **acme-api**, add rate
  limiting…"). The Supervisor matches it to a registry entry.
- If the repo is missing or ambiguous, the Supervisor **asks in-thread before
  spawning** — it never guesses a path.
- `spawn_worker({ repo, task })` takes the registry *name*; the Bridge resolves
  it to a path and sets the worker's `cwd`.

## Tools

Hosted by the Bridge as in-process MCP tools.

### Supervisor tools

| Tool | Purpose |
| --- | --- |
| `list_repos()` | Return the repo registry (names + short descriptions). |
| `spawn_worker({ repo, task, thread_root_id })` | Start a worker in `repo` for `task`, bound to the given thread. |
| `list_workers()` | Return active/failed/finished workers and their threads. |
| `stop_worker({ worker_id })` | Terminate a worker session. |
| `post_to_channel({ text, thread_root_id? })` | Post a message (channel-level or into a thread). |

### Worker tools

| Tool | Purpose |
| --- | --- |
| `ask_user({ question })` | Post a question into the worker's thread and **block** until the operator replies; returns the reply. |
| `send_update({ text, files? })` | Post a progress message into the thread, optionally attaching files (specs, plans, diffs). |
| `finish({ summary })` | Post a wrap-up, mark the worker `finished`. |

## Worker Lifecycle

1. **Spawn** — Supervisor resolves the repo and calls `spawn_worker`. The Bridge
   records the worker, sets `cwd`, posts an acknowledgement in the thread.
2. **Run** — the worker works autonomously with the full Claude Code toolset and
   superpowers skills.
3. **Interact** — `ask_user` for input; `send_update` for progress/artifacts
   (outbound attachments carry specs, plans, diffs). Inbound: files the operator
   attaches in a thread reply are downloaded and their paths handed to the worker.
4. **Finish** — `finish(summary)` posts a wrap-up and marks the worker done.

Multiple workers run concurrently, up to a configurable cap. Workers run
**fully autonomously within their repository** — full tool access, no per-action
permission prompts (the devbox is the operator's own machine). This is the
default; the permission mode remains configurable if a stricter mode is ever
wanted.

## State & Persistence (SQLite)

The Bridge owns a SQLite database as the durable source of truth.

**`workers`**
- `id` (pk)
- `thread_root_id` (Mattermost root post id)
- `repo_name`, `repo_path`
- `session_id` (Agent SDK session id, for resume)
- `status` (`running` | `waiting` | `finished` | `failed`)
- `task` (original request text)
- timestamps

**`pending_questions`**
- `id` (pk)
- `worker_id` (fk)
- `question_post_id` (Mattermost post id of the question)
- `resolved` (bool)
- `answer` (nullable)
- timestamps

On Bridge restart it reconciles from SQLite: Agent SDK sessions are resumed by
`session_id`. A worker whose session cannot be resumed gets a posted notice in
its thread and is marked `failed`. Unresolved `pending_questions` are re-armed so
a later reply still routes correctly.

## Error Handling

- **Worker crash / fatal error** → post the error into the worker's thread, mark
  it `failed`, notify the Supervisor.
- **Mattermost disconnect** → reconnect with exponential backoff; queue outbound
  posts until reconnected.
- **Unanswered `ask_user`** → wait indefinitely; optionally send a single
  reminder ping after a configurable interval.
- **Anthropic API errors** → rely on SDK retries for transient errors; surface
  fatal errors into the relevant thread.

## Testing

Test-driven, per the superpowers workflow.

- **Unit tests (Bridge):**
  - Routing: top-level post → supervisor; thread reply → correct worker; reply to
    a worker-less thread → supervisor.
  - `ask_user` block/resolve cycle: the held tool call resolves with the exact
    reply text; `pending_questions` transitions correctly.
  - Repo resolution: known name resolves; unknown/ambiguous name triggers an
    in-thread question rather than a spawn.
  - Restart reconciliation: sessions re-armed from SQLite; unresumable workers
    marked failed with a notice.
  - These run against a **mock Mattermost client** and **mock sessions**.
- **Integration test:** a throwaway repository and a scripted feature request
  driving the full path — spawn → `ask_user` → operator answer → `send_update`
  with an attachment → `finish` — end to end.

## Configuration

- Mattermost: server URL, bot personal access token, channel id.
- Repo registry: `name → { path, description }`.
- Concurrency cap for workers.
- Worker permission mode (default: fully autonomous within the repo).
- Local scratch directory for downloaded inbound attachments.
- Optional `ask_user` reminder interval.

## Stack

- Runtime: Node.js / TypeScript.
- Mattermost: official `@mattermost/client` (WebSocket + REST).
- Claude sessions: **Claude Agent SDK (TypeScript)**, driving Claude Code
  sessions with in-process MCP custom tools and native auto-compaction.
- State: SQLite (e.g. `better-sqlite3`).

## Open questions for implementation planning

- Exact Agent SDK entry points for a persistent streaming session, in-process MCP
  tool definitions, and session resume-by-id — to be confirmed against the
  current SDK when writing the plan.
