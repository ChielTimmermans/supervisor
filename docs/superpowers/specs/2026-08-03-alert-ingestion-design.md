# Alert Ingestion & Read-only Investigation — Design

**Date:** 2026-08-03
**Status:** Approved design, pending sample alert formats + implementation plan

## Summary

Extend the supervisor to ingest monitoring events (Prometheus/Alertmanager and
GlitchTip) from dedicated Mattermost channels. When a genuinely-new incident
arrives, the bridge automatically opens an **investigation thread in the main
channel** and spawns a worker that diagnoses the alert using **read-only**
cluster and monitoring access, then proposes a code fix for the operator to
review. Incidents are de-duplicated so repeated alert firings don't flood.

## Confirmed decisions

- **Auto-investigate, read-only.** Alerts auto-spawn an investigation worker; the
  worker diagnoses but never remediates on the cluster. Fixes come back as code
  changes / PRs the operator reviews.
- **De-duplicate per incident.** One active investigation per alert fingerprint;
  re-fires annotate the existing thread, resolved events annotate it; the
  operator closes with `/done`.
- **Service→repo mapping** in config; when a repo can't be resolved, the
  supervisor asks the operator which repo to open a fix in.
- **Safety model:** read-only cluster RBAC is the enforced boundary (not the
  agent); remediation is PR-only. Confirmed.

## Architecture

### Channels

- `mainChannel` = the existing `MM_CHANNEL_ID` — operator conversation and all
  investigation threads live here.
- `ingestChannels`: a configured list of `{ channelId, source }` where `source`
  is `prometheus` or `glitchtip`. The bot must be a member of each. The bridge
  listens to the main channel **and** the ingest channels; ingest-channel posts
  are handled as **alert events**, never as operator conversation, and never as
  worker-thread replies.

### Alert path (bridge-orchestrated; the LLM supervisor is used only when needed)

The noisy alert stream is handled **deterministically** by the bridge — it does
not pay an LLM turn per alert. The intelligence lives in the investigation
worker. The supervisor is consulted only for ambiguity (unknown repo).

1. **Parse.** A post in an ingest channel is parsed per `source` into an
   `AlertEvent`: `{ fingerprint, status: 'firing' | 'resolved', service?,
   severity?, summary, sourceUrl? }`.
2. **De-dup** against an `incidents` table keyed by `fingerprint`:
   - `firing` + no open incident (or the previous one is past cooldown) → **new incident**.
   - `firing` + open incident → annotate its thread ("re-fired ×N"); **no new worker**.
   - `resolved` + open incident → post "✅ resolved upstream" in its thread; leave
     the investigation open for the operator to `/done`.
3. **Resolve repo** for a new incident via the service→repo map.
   - **mapped** → the bridge opens an investigation thread in the **main channel**
     (root post: "🚨 Investigating: \<summary\>") and spawns an **investigation
     worker** in that repo, bound to the thread, with the alert context + source
     links as its task.
   - **unmapped** → the bridge asks the **supervisor** (one LLM turn) to pick the
     repo or ask the operator; on answer, spawn as above.
4. **Record** the incident: fingerprint, source, service, repo, threadRootId,
   workerId, status, summary, timestamps, refire count.

### Investigation worker

A normal `Worker` with an **investigation** system-prompt addendum:

- States the read-only tools available on the devbox: `kubectl` via `$KUBECONFIG`
  (read-only RBAC), Prometheus at `$PROM_URL` (+ `$PROM_TOKEN`), GlitchTip at
  `$GLITCHTIP_URL` (+ `$GLITCHTIP_TOKEN`) — used via `Bash` (`kubectl get`,
  `curl`, etc.).
- Instructs: diagnose the root cause; **do NOT** change anything on the cluster;
  propose a fix as **code changes in this repo**; call `finish` with the
  diagnosis + proposed change (operator-gated completion, same as normal workers).

Workers already inherit the devbox environment (`env: { ...process.env, … }`), so
credentials present on the box are available with no extra wiring. Read-only RBAC
enforces safety regardless of what the model types.

### Config additions

- `INGEST_CHANNELS_JSON` — `[{ "channelId": "...", "source": "prometheus" | "glitchtip" }]`
- `SERVICE_REPO_MAP_JSON` — `{ "<service-or-label value>": "<repo registry name>" }`
- `INCIDENT_COOLDOWN_MS` — cooldown before the same fingerprint re-opens (default 1h).
- Access credentials (`KUBECONFIG`, `PROM_URL`, `PROM_TOKEN`, `GLITCHTIP_URL`,
  `GLITCHTIP_TOKEN`) live in the **devbox environment**, not app config.

### Data model — `incidents`

`id`, `fingerprint`, `source`, `service`, `repo_name`, `thread_root_id`,
`worker_id`, `status` (`open` | `resolved_upstream` | `closed`), `summary`,
`created_at`, `last_seen_at`, `refire_count`. When the operator `/done`s an
investigation thread, the linked incident is set `closed`.

### Parsing (source-specific; formats confirmed from real samples)

Parsers prefer an explicit stable id if the webhook template provides one
(Alertmanager `{{ .Fingerprint }}`, GlitchTip issue URL), else fall back to the
heuristic below.

**Prometheus/Alertmanager** (rendered Mattermost template), e.g.:
```
:red_circle: [FIRING] KubeProxyDown
Target disappeared from Prometheus target discovery.
KubeProxy has disappeared from Prometheus target discovery.
📊 Open Grafana (Infrastructure)
```
- `status`: `[FIRING]` → firing, `[RESOLVED]` → resolved (cross-check the emoji
  `:red_circle:` / `:large_green_circle:`).
- alert name: the token after `[FIRING]`/`[RESOLVED]` (`KubeProxyDown`).
- `severity`: from the emoji.
- `summary`: the description line(s) following the header.
- `fingerprint`: the alert name (the template groups by alertname; no per-instance
  labels are rendered). Include sorted labels if a deployment renders them.

**GlitchTip** (Mattermost notification), e.g.:
```
GlitchTip Alert
TypeError: Failed to fetch dynamically imported module: https://console…/chunk-V4J…
Project        Environment
console-frontend   development
```
- error title: the line after the `GlitchTip Alert` header.
- `service` = Project (`console-frontend`); environment recorded (`development`).
- `summary`: the error title.
- `fingerprint`: `hash(project + environment + normalize(errorTitle))`, where
  `normalize` strips volatile tokens — URLs, chunk hashes (`chunk-V4J…`), and long
  hex/number runs — so redeploys don't spawn a fresh incident every time.

`alerts-business` ("nothing yet") is left unconfigured until it has a format.

### Interaction with existing pieces

- **Router:** ingest-channel posts are handled before the normal router (they're
  alert events, not operator/thread messages). Main-channel behavior is unchanged.
- **Investigation threads** behave like any worker thread: reply to continue,
  `/done` to close (which also closes the incident).
- **Concurrency:** investigations count against `WORKER_CONCURRENCY`. A separate
  cap for investigations can be added later if alerts are bursty.

## Non-goals (v1)

- No live remediation (read-only only).
- No auto-close of investigations — the operator `/done`s.
- No severity-based approval gating — everything auto-investigates read-only
  (can add a low-severity "ask first" toggle later).
- No wrapper MCP tools for kubectl/Prometheus/GlitchTip — start with `Bash` +
  documented access behind read-only RBAC; add auditable tool wrappers later if
  wanted.

## Unmapped-repo alerts (resolved)

An alert whose service isn't in the repo map (e.g. the infra alert `KubeProxyDown`)
still spawns a **read-only diagnosis worker** — but with **no repo cwd** (a scratch
working directory), cluster/monitoring access only. It investigates and reports;
if a code fix is warranted it names where it belongs and the supervisor asks the
operator which repo to continue in. Default is **diagnose-anyway**, not wait.

## Open items

- Cooldown default and whether `resolved_upstream` should also nudge the operator
  to close the thread.
- Optional: switch parsers to explicit webhook ids (`{{ .Fingerprint }}` /
  GlitchTip issue URL) if the templates can include them.
