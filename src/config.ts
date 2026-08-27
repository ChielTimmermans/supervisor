import type { IngestChannel } from './types.js';

export interface RepoEntry { path: string; description: string }

export interface Config {
  mattermost: { url: string; token: string; channelId: string };
  repos: Record<string, RepoEntry>;
  ingestChannels: IngestChannel[];
  serviceRepoMap: Record<string, string>;
  incidentCooldownMs: number;
  workerConcurrency: number;
  investigationConcurrency: number;
  askUserTimeoutMs: number;
  attachmentDir: string;
  dbPath: string;
  model?: string;
  /** How long a dev-env claim may be held before another worker may break it as stale. */
  devClaimTtlMs: number;
  /** How long a worker waits for a busy dev env before giving up and returning control. */
  devClaimWaitTimeoutMs: number;
  /** Inactivity watchdog: reconnect a worker's turn if no stream message arrives for this long. */
  watchdogIdleMs: number;
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
    ingestChannels: env.INGEST_CHANNELS_JSON ? JSON.parse(env.INGEST_CHANNELS_JSON) as IngestChannel[] : [],
    serviceRepoMap: env.SERVICE_REPO_MAP_JSON ? JSON.parse(env.SERVICE_REPO_MAP_JSON) as Record<string, string> : {},
    incidentCooldownMs: env.INCIDENT_COOLDOWN_MS ? Number(env.INCIDENT_COOLDOWN_MS) : 3_600_000,
    workerConcurrency: env.WORKER_CONCURRENCY ? Number(env.WORKER_CONCURRENCY) : 3,
    investigationConcurrency: env.INVESTIGATION_CONCURRENCY ? Number(env.INVESTIGATION_CONCURRENCY) : 2,
    askUserTimeoutMs: env.ASK_USER_TIMEOUT_MS ? Number(env.ASK_USER_TIMEOUT_MS) : 86_400_000,
    attachmentDir: env.ATTACHMENT_DIR ?? './scratch/attachments',
    dbPath: env.DB_PATH ?? './data/supervisor.sqlite',
    model: env.MODEL,
    devClaimTtlMs: env.DEV_CLAIM_TTL_MS ? Number(env.DEV_CLAIM_TTL_MS) : 1_800_000, // 30 min
    devClaimWaitTimeoutMs: env.DEV_CLAIM_WAIT_TIMEOUT_MS ? Number(env.DEV_CLAIM_WAIT_TIMEOUT_MS) : 900_000, // 15 min
    watchdogIdleMs: env.WATCHDOG_IDLE_MS ? Number(env.WATCHDOG_IDLE_MS) : 1_200_000, // 20 min
  };
}
