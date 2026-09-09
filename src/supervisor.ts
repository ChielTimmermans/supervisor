import { ClaudeSession, type QueryFn } from './session.js';
import { log } from './log.js';
import type { Db } from './db.js';
import type { Config } from './config.js';
import type { Gateway } from './mattermost.js';

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
  gateway: Gateway;
  /** Test seam: override the usage-limit retry wait so tests don't sleep. */
  wait?: (ms: number) => Promise<void>;
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
        wait: deps.wait,
        watchdogIdleMs: deps.cfg.watchdogIdleMs,
        watchdogWaitingIdleMs: deps.cfg.watchdogWaitingIdleMs,
        maxConsecutiveSilentReconnects: deps.cfg.maxConsecutiveSilentReconnects,
      },
      (id) => { log.debug('supervisor session id', { session: id }); deps.db.setMeta('supervisor_session', id); },
      (err) => log.error('supervisor session error', { err: err instanceof Error ? err.message : String(err) }),
      // Usage/rate limit: the supervisor pauses and auto-resumes — it must never go permanently deaf.
      (resetAt) => {
        const when = resetAt ? ` resuming ~${resetAt.toISOString().slice(11, 16)} UTC` : ' will retry shortly';
        log.warn('supervisor paused on usage limit', { resetAt: resetAt?.toISOString() ?? '(unknown)' });
        void deps.gateway.post({ text: `⏳ Supervisor paused — hit the usage limit,${when}. Alerts and messages will be handled once usage returns.` });
      },
      () => {
        log.info('supervisor resumed after usage limit');
        void deps.gateway.post({ text: '▶️ Supervisor resumed — usage available again.' });
      },
      ({ idleMs }) => {
        const minutes = Math.round(idleMs / 60_000);
        log.warn('supervisor turn watchdog fired — reconnecting', { idleMs });
        void deps.gateway.post({ text: `⚠️ Supervisor seemed stuck (no activity for ~${minutes} min) — reconnecting and retrying automatically.` });
      },
      // Gave up on in-process recovery: see worker.ts's identical callback — the
      // supervisor hit exactly this failure mode in a real overnight incident.
      ({ consecutiveSilentReconnects }) => {
        log.error('supervisor gave up on in-process recovery — restarting the whole process', { consecutiveSilentReconnects });
        void deps.gateway.post({ text: `🔴 Supervisor produced no output across ${consecutiveSilentReconnects} reconnect attempts — restarting the whole process to recover. It will pick back up here shortly.` });
      },
      // See worker.ts's identical callback: a plain-text-only reply (no tool
      // call) is otherwise invisible — the supervisor only ever posts via
      // post_to_channel/spawn_worker's own posts.
      (text) => {
        log.warn('supervisor turn ended with plain text and no tool call — posting fallback', { preview: text.slice(0, 200) });
        void deps.gateway.post({ text: `💬 ${text}` });
      },
    );
  }
  start(seed: string): void { this.session.start(seed); }
  push(text: string): void { this.session.push(text); }
  stop(): void { this.session.stop(); }
}
