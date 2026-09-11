import 'dotenv/config';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { MattermostGateway } from './mattermost.js';
import { Bridge } from './bridge.js';
import { log } from './log.js';
import { installCrashGuards } from './crashGuards.js';
import { writePidFile, installSelfReload } from './selfReload.js';
import { DEFAULT_WATCHDOG_KILL_GRACE_MS } from './session.js';
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
  if (process.env.SUPERVISOR_RESPAWNED === '1') {
    // Spawned as selfReload.ts's replacement — the old process might still be alive
    // (cleanly shutting down, or — as observed in production — crashing partway
    // through its own shutdown with no JS-level error). Wait past its
    // SIGTERM->SIGKILL escalation window before touching the DB/gateway/sessions,
    // so we don't race its dying children for the same session ids.
    log.info('respawned process: waiting for the old process to fully stop', { graceMs: DEFAULT_WATCHDOG_KILL_GRACE_MS });
    await new Promise((resolve) => setTimeout(resolve, DEFAULT_WATCHDOG_KILL_GRACE_MS));
  }
  // Note: during the wait above, data/supervisor.pid still names the OLD (now
  // dead or dying) process — this process deliberately doesn't claim the
  // pidfile until it's actually ready to take over. A `kill -HUP` aimed at
  // that stale pid during this window is harmless (already reloading, or ESRCH).
  writePidFile(path.join(dataDir, 'supervisor.pid'));
  const db = new Db(cfg.dbPath);
  const gateway = new MattermostGateway(cfg.mattermost, cfg.ingestChannels.map((c) => c.channelId), undefined, db);
  const bridge = new Bridge({ queryFn: query, gateway, db, cfg });
  await bridge.start();
  log.info('bridge online');

  let stopped = false;
  const gracefulStop = async () => {
    if (stopped) return;
    stopped = true;
    log.info('shutting down');
    // Awaited — bridge.shutdown() now drains each session's queue (stopGracefully)
    // before aborting, so a message push()'d just before shutdown actually reaches
    // the model instead of being silently discarded. See ClaudeSession.drainAndStop.
    await bridge.shutdown();
    log.info('bridge shutdown complete, closing db');
    db.close();
    log.info('db closed');
  };
  // Note: installSelfReload's SIGHUP path now spawns the replacement BEFORE calling
  // onReload (this gracefulStop), specifically so a crash during shutdown can't
  // prevent the replacement from existing — see selfReload.ts. SIGINT/SIGTERM don't
  // spawn anything, so no equivalent race applies to them.
  process.on('SIGINT', () => { void gracefulStop().then(() => process.exit(0)); });
  process.on('SIGTERM', () => { void gracefulStop().then(() => process.exit(0)); });
  installSelfReload({
    logFile: path.join(dataDir, 'supervisor.log'),
    onReload: gracefulStop,
  });
}
main().catch((err) => { log.error('fatal on startup', { err: err instanceof Error ? err.message : String(err) }); console.error(err); process.exit(1); });
