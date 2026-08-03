import { ClaudeSession, type QueryFn } from './session.js';
import { log } from './log.js';
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
      (id) => { log.debug('supervisor session id', { session: id }); deps.db.setMeta('supervisor_session', id); },
      (err) => log.error('supervisor session error', { err: err instanceof Error ? err.message : String(err) }),
    );
  }
  start(seed: string): void { this.session.start(seed); }
  push(text: string): void { this.session.push(text); }
}
