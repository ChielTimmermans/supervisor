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
