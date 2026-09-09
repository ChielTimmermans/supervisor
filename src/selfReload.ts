import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, openSync } from 'node:fs';
import { log } from './log.js';
import { DEFAULT_WATCHDOG_KILL_GRACE_MS } from './session.js';

export type SpawnFn = (command: string, args: string[], options: Record<string, unknown>) => ChildProcess;

export interface SelfReloadDeps {
  logFile: string;
  /** Graceful shutdown to run before respawning: stop sessions/subprocesses, close the gateway. */
  onReload: () => Promise<void>;
  spawnFn?: SpawnFn;
  exit?: (code: number) => void;
  // onReload only sends SIGTERM to each session's claude subprocess (via abort()); the SDK
  // only escalates to SIGKILL after up to 5s (see session.ts's DEFAULT_WATCHDOG_KILL_GRACE_MS,
  // the same constraint at the single-connection level). Spawning the replacement before that
  // elapses would let the old process's dying children overlap with the new process's own
  // sessions resuming the same session ids. Defaults to DEFAULT_WATCHDOG_KILL_GRACE_MS.
  respawnGraceMs?: number;
  // Test seam for the above wait.
  graceWait?: (ms: number) => Promise<void>;
}

export function writePidFile(pidFile: string): void {
  writeFileSync(pidFile, String(process.pid));
}

/**
 * On SIGHUP: run the graceful shutdown, spawn a detached replacement of this same
 * process (same interpreter, same args, same cwd/env), then exit. There is no external
 * process manager for this bot, so the reload has to relaunch itself.
 */
export function installSelfReload(deps: SelfReloadDeps): void {
  const spawnFn = deps.spawnFn ?? (spawn as unknown as SpawnFn);
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let reloading = false;

  process.on('SIGHUP', () => {
    if (reloading) return; // a reload is already in flight — ignore the repeat signal
    reloading = true;
    void (async () => {
      log.info('SIGHUP received — reloading');
      try {
        await deps.onReload();
      } catch (err) {
        log.error('graceful shutdown before reload failed', { err: err instanceof Error ? err.message : String(err) });
      }
      const graceMs = deps.respawnGraceMs ?? DEFAULT_WATCHDOG_KILL_GRACE_MS;
      const graceWait = deps.graceWait ?? ((ms: number) => new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        (t as unknown as { unref?: () => void })?.unref?.();
      }));
      await graceWait(graceMs);
      // By now onReload has already torn down sessions/gateway/DB, so a failure here must not
      // fall through as an unhandled rejection: that would leave the process alive with nothing
      // running and no replacement — a silent, unrecoverable zombie. Exit loudly instead.
      try {
        const out = openSync(deps.logFile, 'a');
        const err = openSync(deps.logFile, 'a');
        const child = spawnFn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
          cwd: process.cwd(),
          env: process.env,
          detached: true,
          stdio: ['ignore', out, err],
        });
        child.unref();
        log.info('respawned replacement process', { pid: child.pid });
        exit(0);
      } catch (err) {
        log.error('respawn failed — exiting without a replacement running', { err: err instanceof Error ? err.message : String(err) });
        exit(1);
      }
    })();
  });
}
