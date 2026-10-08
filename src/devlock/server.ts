import 'dotenv/config';
import { Db } from '../db.js';
import { DevEnvLocks } from '../devEnvLocks.js';
import { createDevlockApp } from './app.js';
import { createGcMailNotifier } from './notify.js';
import { listActiveSessionIds } from './sessions.js';
import { log } from '../log.js';

async function main() {
  const gcBin = process.env.GC_BIN ?? 'gc';
  const dbPath = process.env.DEVLOCK_DB_PATH ?? './data/devlock.sqlite';
  const port = Number(process.env.DEVLOCK_PORT ?? 4810);
  const ttlMs = process.env.DEV_CLAIM_TTL_MS ? Number(process.env.DEV_CLAIM_TTL_MS) : 1_800_000;
  const waitTimeoutMs = process.env.DEV_CLAIM_WAIT_TIMEOUT_MS ? Number(process.env.DEV_CLAIM_WAIT_TIMEOUT_MS) : 900_000;

  const db = new Db(dbPath);
  const locks = new DevEnvLocks(db, { ttlMs, waitTimeoutMs });

  const activeIds = await listActiveSessionIds(gcBin);
  locks.reconcile((workerId) => activeIds.has(workerId));
  log.info('devlock: startup reconciliation complete', { activeSessions: activeIds.size });

  const app = createDevlockApp(locks, createGcMailNotifier(gcBin));
  app.listen(port, () => log.info('devlock: listening', { port }));
}

main().catch((err) => {
  log.error('devlock: fatal startup error', { error: String(err) });
  process.exit(1);
});
