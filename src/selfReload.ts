import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, openSync } from 'node:fs';
import { log } from './log.js';

export type SpawnFn = (command: string, args: string[], options: Record<string, unknown>) => ChildProcess;

export interface SelfReloadDeps {
  logFile: string;
  /** Graceful shutdown to run after spawning the replacement: stop sessions/subprocesses, close the gateway. */
  onReload: () => Promise<void>;
  spawnFn?: SpawnFn;
  exit?: (code: number) => void;
}

export function writePidFile(pidFile: string): void {
  writeFileSync(pidFile, String(process.pid));
}

/**
 * On SIGHUP: spawn a detached replacement of this same process (same interpreter,
 * same args, same cwd/env) FIRST, then run the graceful shutdown, then exit. There
 * is no external process manager for this bot, so the reload has to relaunch itself.
 *
 * Spawn-first is deliberate: a real incident showed onReload (stopping every live
 * session's subprocess, closing the gateway, closing the DB, all concurrently) can
 * crash the process outright with no JS-level error — bypassing try/catch entirely.
 * If that happens after spawning, a replacement is already on its way instead of
 * nothing ever running again. The replacement waits out the old process's
 * SIGTERM->SIGKILL escalation window on ITS OWN side (see index.ts,
 * SUPERVISOR_RESPAWNED) before resuming any sessions, so the two don't race each
 * other for the same session ids.
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

      let spawnedOk = false;
      try {
        const out = openSync(deps.logFile, 'a');
        const err = openSync(deps.logFile, 'a');
        const child = spawnFn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
          cwd: process.cwd(),
          env: { ...process.env, SUPERVISOR_RESPAWNED: '1' },
          detached: true,
          stdio: ['ignore', out, err],
        });
        child.unref();
        log.info('respawned replacement process', { pid: child.pid });
        spawnedOk = true;
      } catch (err) {
        log.error('respawn failed — no replacement will be running', { err: err instanceof Error ? err.message : String(err) });
      }

      try {
        await deps.onReload();
      } catch (err) {
        log.error('graceful shutdown before exit failed', { err: err instanceof Error ? err.message : String(err) });
      }

      exit(spawnedOk ? 0 : 1);
    })();
  });
}
