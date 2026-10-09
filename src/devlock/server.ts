import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Db } from '../db.js';
import { DevEnvLocks } from '../devEnvLocks.js';
import { createDevlockApp } from './app.js';
import { createGcMailNotifier } from './notify.js';
import { listActiveSessionIds } from './sessions.js';
import { log } from '../log.js';

/**
 * Read a numeric env var, falling back to `fallback` when it's unset or
 * non-numeric. Logs a warning only when the value is present but malformed
 * (garbage), not when it's simply unset — that's the normal case.
 */
function numEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    log.warn('devlock: malformed numeric env var; using fallback', { name, value: v, fallback });
    return fallback;
  }
  return n;
}

async function main() {
  const gcBin = process.env.GC_BIN ?? 'gc';
  const dbPath = process.env.DEVLOCK_DB_PATH ?? './data/devlock.sqlite';
  const port = numEnv('DEVLOCK_PORT', 4810);
  const ttlMs = numEnv('DEV_CLAIM_TTL_MS', 1_800_000);
  const waitTimeoutMs = numEnv('DEV_CLAIM_WAIT_TIMEOUT_MS', 900_000);

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Db(dbPath);
  const locks = new DevEnvLocks(db, { ttlMs, waitTimeoutMs });

  const activeIds = await listActiveSessionIds(gcBin);
  if (activeIds === null) {
    log.warn('devlock: could not determine active sessions; skipping startup reconciliation this run');
  } else {
    locks.reconcile((workerId) => activeIds.has(workerId));
    log.info('devlock: startup reconciliation complete', { activeSessions: activeIds.size });
  }

  const app = createDevlockApp(locks, createGcMailNotifier(gcBin));
  app.listen(port, '127.0.0.1', () => log.info('devlock: listening', { port }));
}

main().catch((err) => {
  log.error('devlock: fatal startup error', { error: String(err) });
  process.exit(1);
});
