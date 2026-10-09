# Migrate supervisor to Gas City

## Context

The current `supervisor` is a bespoke Mattermost-chat-driven orchestrator
(Node/TypeScript, Claude Agent SDK) that spawns per-thread "workers," tracks
them in SQLite, enforces a per-repo shared-dev-environment lock
(`claim_dev`/`release`/`kill`), and ingests Prometheus/Glitchtip alerts into a
separate pool of read-only investigation workers. It carries significant
custom resilience code (`watchdog.ts`, `selfReload.ts`, `crashGuards.ts`,
reconnect handling in `session.ts`) to keep the Node process and its worker
sessions alive.

We are replacing it with [Gas City](https://github.com/gastownhall/gascity),
an open-source Go orchestration SDK (agents, beads, formulas, rigs, packs,
events as composable primitives; a controller loop that reconciles
desired-vs-running state; pools with demand-based scaling; an HTTP+SSE
`extmsg` API for external chat-style clients; orders that trigger formulas or
scripts on a schedule/condition/event).

## Goals

- Replace the custom worker-spawning, concurrency-limiting, and
  crash-recovery logic in `supervisor.ts`/`worker.ts`/`watchdog.ts`/
  `selfReload.ts`/`crashGuards.ts` with Gas City's controller, pools, and bead
  store.
- Keep Mattermost chat as the primary interaction surface.
- Add Gitea issues and Trello cards as additional work-intake sources.
- Keep the alert-ingestion → investigation-worker pipeline (Prometheus /
  Glitchtip), as a separately-capped pool so an alert storm can't starve
  feature work.
- Keep the shared-dev-environment lock (`claim_dev`/`release`/`kill`,
  TTL-based stale-break) — this is a hard constraint, not something Gas
  City's per-rig isolation can remove, because the constrained resource is
  one shared devbox per repo, not compute isolation.
- Cut over all repos and intake sources in one pass (big-bang), after an
  end-to-end dry run against one throwaway rig.

## Non-goals

- Changing which coding agent runs the work (stays Claude; Gas City wires
  Claude's hooks automatically via `gc init`).
- Removing or redesigning the dev-env lock's semantics — port its logic,
  don't redesign it.
- Building new approval-gate / risk-tier automation (e.g. auto-merge tiers)
  as part of this migration — out of scope unless called out separately
  later.
- Decommissioning Gitea or GitHub in favor of GitLab — Gas City is host
  agnostic (rigs are just git repos; agents still talk to Gitea/GitHub APIs
  directly for PR creation, unchanged).

## Architecture

One Gas City instance (`gc supervisor`, dashboard on `:8372`) runs on the
same devbox that currently runs the `supervisor` tmux session, with a city
config declaring:

- **Rigs** — one per repo currently listed in the supervisor's `REPOS_JSON`,
  registered via `gc rig add <path>`.
- **Two pools**:
  - `worker` — feature/chat-driven work. `max_active_sessions` takes over
    the role of today's `WORKER_CONCURRENCY` (currently 3).
  - `investigator` — alert-triggered, read-only diagnostic work, scaled and
    capped independently (today's `INVESTIGATION_CONCURRENCY`, currently 2),
    so alert volume can't starve feature work.
- **Four bridge processes** — the custom integration layer that has no Gas
  City equivalent and is the real rebuild work of this migration. Each talks
  to Gas City over the `/v0/extmsg` HTTP+SSE API and the `gc`/`bd` CLI, never
  by importing Gas City internals directly:
  - **Mattermost bridge** — replaces the chat-handling core of today's
    `bridge.ts`/`mattermost.ts`. Listens on the Mattermost WS connection as
    today. On a new thread or message: register an `extmsg` client if one
    isn't already bound to that thread, subscribe to its SSE reply stream,
    and POST the message as an inbound turn (`gc sling worker "<task>"` to
    create the session if none is bound yet, otherwise a plain inbound turn
    to the existing binding). Session replies arriving on the SSE stream are
    posted back into the Mattermost thread. `/approve`, `/release`, `/kill`
    chat commands are intercepted bridge-side exactly as today — `/release`
    and `/kill` call the dev-lock MCP server directly; they are operator
    interventions, not formula steps.
  - **Gitea issue bridge** — new. Webhook (or poll, if webhook delivery to
    the devbox isn't feasible) on each registered repo's issue tracker.
    New issue → resolve the target rig → `gc sling <rig>/worker "<issue
    title + body>"`. One-shot: no `extmsg` conversational binding. On bead
    close, post a comment back to the issue with the outcome.
  - **Trello bridge** — new, same shape as the Gitea bridge, triggered by
    card creation/movement into a configured list.
  - **Alert-ingestion bridge** — ports today's `alerts.ts` behavior:
    Prometheus/Glitchtip webhooks, `SERVICE_REPO_MAP_JSON` to resolve a repo
    from an alert's service label, `INCIDENT_COOLDOWN_MS` fingerprint-based
    dedup (kept as custom logic in the bridge — Gas City's `cooldown` order
    trigger is time-based per-order, not per-fingerprint, so it doesn't fit
    this case). On a new, non-cooling-down alert: `gc sling
    <rig>/investigator "<alert>"`. Unmapped alerts still diagnose into a
    scratch dir rather than a rig, as today.
- **Dev-lock MCP server** — `claim_dev`/`release`/`kill` and TTL-based
  stale-claim breaking, ported from `devEnvLocks.ts` with its existing
  semantics (`DEV_CLAIM_TTL_MS`, `DEV_CLAIM_WAIT_TIMEOUT_MS`) unchanged.
  Exposed as an MCP tool wired into every `worker` agent (not
  `investigator` agents, which are read-only and never touch the shared
  devbox). This is the one piece of today's system with no Gas City
  primitive to replace it — bead `needs` edges express a DAG, not a
  mutex-with-TTL — so it stays bespoke infrastructure sitting beside Gas
  City rather than inside it.

## Data flow

**Chat path:** Mattermost message → bridge registers/subscribes an `extmsg`
client for the thread if not already bound → `gc sling worker "<task>"` (new
thread) or a plain inbound turn (existing thread) → the `worker` pool's
`scale_check` spins up or reuses a session → the agent works, calling the
dev-lock tool before touching the shared devbox, calling Gitea's API
directly for PRs exactly as today → replies arrive on the SSE stream → bridge
posts them to the thread → agent closes its bead on completion → pool scales
back down when idle.

**Issue/card path (Gitea, Trello):** webhook → bridge resolves the target rig
→ `gc sling <rig>/worker "<summary>"` → same session lifecycle as the chat
path, but one-shot (no `extmsg` binding) → on bead close, bridge posts a
comment / moves the card using the bead's final state.

**Alert path:** webhook → ingestion bridge checks `INCIDENT_COOLDOWN_MS`
against the fingerprint → resolves repo via `SERVICE_REPO_MAP_JSON` → `gc
sling <rig>/investigator "<alert>"` → investigator session runs read-only
(no dev-lock claim) → on bead close, bridge posts the diagnosis to the alerts
channel via the Mattermost bridge's client.

## Error handling

Gas City's controller reconciliation (adopts live sessions on its own
restart; respawns dead ones from the bead store) replaces `watchdog.ts`,
`selfReload.ts`, and `crashGuards.ts` for worker/investigator **sessions**.
That code is deleted, not ported.

The **bridges** are not supervised by Gas City and keep their own
reconnect/retry logic — initially a close port of `session.ts`'s existing
Mattermost WS reconnect handling into the new Mattermost bridge. We are not
committing to new resilience design for the bridges up front; we revisit if
one proves flaky in practice.

Dev-lock failure semantics are unchanged: TTL-based stale-claim breaking,
`DEV_CLAIM_WAIT_TIMEOUT_MS` give-up, operator `/release` and `/kill` as
manual overrides.

## Testing & cutover

Dry run first, even though the cutover itself is big-bang: register one
throwaway rig (not a real chipmakers repo), exercise all four bridges and the
dev-lock against it end to end, and confirm pool scaling and the `extmsg`
reply loop work correctly. Only then cut every real repo, the live
Mattermost channel, and the Gitea/Trello webhooks over in a single pass, and
stop/decommission the old `supervisor` tmux session and process.

## Open risks

- Gitea/Trello webhook delivery to the devbox may require a poller instead
  of true webhooks depending on network reachability — to be resolved during
  implementation, not blocking this design.
- The bridges' bespoke resilience is explicitly not hardened up front; if
  the Mattermost bridge proves less reliable than today's supervisor in
  practice, that becomes follow-up work, not a blocker to cutover.
