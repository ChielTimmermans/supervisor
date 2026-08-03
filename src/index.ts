import 'dotenv/config';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { MattermostGateway } from './mattermost.js';
import { Bridge } from './bridge.js';
import { log } from './log.js';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

async function main() {
  const cfg = loadConfig(process.env, process.env.REPOS_JSON ?? '{}');
  log.info('starting supervisor', {
    channel: cfg.mattermost.channelId,
    repos: Object.keys(cfg.repos).join(',') || '(none)',
    concurrency: cfg.workerConcurrency,
  });
  await mkdir(path.dirname(cfg.dbPath), { recursive: true });
  const db = new Db(cfg.dbPath);
  const gateway = new MattermostGateway(cfg.mattermost);
  const bridge = new Bridge({ queryFn: query, gateway, db, cfg });
  await bridge.start();
  log.info('bridge online');

  const shutdown = () => { log.info('shutting down'); gateway.close(); db.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
main().catch((err) => { log.error('fatal on startup', { err: err instanceof Error ? err.message : String(err) }); console.error(err); process.exit(1); });
