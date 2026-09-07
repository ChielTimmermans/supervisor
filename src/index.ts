import 'dotenv/config';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { MattermostGateway } from './mattermost.js';
import { Bridge } from './bridge.js';
import { log } from './log.js';
import { installCrashGuards } from './crashGuards.js';
import { writePidFile, installSelfReload } from './selfReload.js';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

async function main() {
  installCrashGuards();
  const cfg = loadConfig(process.env, process.env.REPOS_JSON ?? '{}');
  log.info('starting supervisor', {
    channel: cfg.mattermost.channelId,
    ingest: cfg.ingestChannels.map((c) => `${c.channelId}:${c.source}`).join(',') || '(none)',
    repos: Object.keys(cfg.repos).join(',') || '(none)',
    concurrency: cfg.workerConcurrency,
  });
  const dataDir = path.dirname(cfg.dbPath);
  await mkdir(dataDir, { recursive: true });
  writePidFile(path.join(dataDir, 'supervisor.pid'));
  const db = new Db(cfg.dbPath);
  const gateway = new MattermostGateway(cfg.mattermost, cfg.ingestChannels.map((c) => c.channelId), undefined, db);
  const bridge = new Bridge({ queryFn: query, gateway, db, cfg });
  await bridge.start();
  log.info('bridge online');

  let stopped = false;
  const gracefulStop = () => {
    if (stopped) return;
    stopped = true;
    log.info('shutting down');
    bridge.shutdown();
    db.close();
  };
  // Note: SIGINT/SIGTERM exit right after gracefulStop() returns, while installSelfReload's SIGHUP
  // path awaits it (onReload is async) before respawning — so a SIGINT/SIGTERM arriving in that
  // brief window can exit the process before a concurrent reload gets to spawn its replacement.
  process.on('SIGINT', () => { gracefulStop(); process.exit(0); });
  process.on('SIGTERM', () => { gracefulStop(); process.exit(0); });
  installSelfReload({
    logFile: path.join(dataDir, 'supervisor.log'),
    onReload: async () => gracefulStop(),
  });
}
main().catch((err) => { log.error('fatal on startup', { err: err instanceof Error ? err.message : String(err) }); console.error(err); process.exit(1); });
