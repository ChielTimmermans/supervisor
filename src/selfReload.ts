import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, openSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { log } from './log.js';

export type SpawnFn = (command: string, args: string[], options: Record<string, unknown>) => ChildProcess;

export interface SelfReloadDeps {
  logFile: string;
  /** Graceful shutdown to run after spawning the replacement: stop sessions/subprocesses, close the gateway. */
  onReload: () => Promise<void>;
  spawnFn?: SpawnFn;
  exit?: (code: number) => void;
  /** Test seam: the running process's Node version (defaults to process.version). */
  nodeVersion?: string;
  /** Test seam: locate a Node binary that satisfies MIN_NODE_MAJOR, used only
   *  when the running version doesn't. Defaults to scanning mise's install dir. */
  findBetterNodeBin?: () => string | undefined;
}

export function writePidFile(pidFile: string): void {
  writeFileSync(pidFile, String(process.pid));
}

// Must match package.json's "engines.node". A real incident: this process was
// (manually, during firefighting) launched under a stray system Node
// v18.19.1 instead of the mise-managed interpreter. self-reload blindly
// re-exec'd process.execPath — whatever binary happened to launch THIS
// process — carrying the bad interpreter forward forever. The respawn then
// crashed immediately (an ESM/CJS package resolution mismatch under the old
// Node) with no operator-visible explanation, cascading into a ~1h crash
// loop only recovered by the external watchdog (scripts/watchdog.sh).
const MIN_NODE_MAJOR = 22;

function nodeMajor(version: string): number {
  return parseInt(version.replace(/^v/, '').split('.')[0] ?? '', 10);
}

/** [major, minor, patch], missing/unparseable parts default to 0 — so ties on
 *  major (e.g. mise holding both 24.18.0 and 24.19.0 at once, a normal
 *  mid-upgrade state) resolve to the actual newest, not filesystem order. */
function semverTuple(version: string): [number, number, number] {
  const parts = version.replace(/^v/, '').split('.').map((p) => parseInt(p, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function compareSemver(a: string, b: string): number {
  const ta = semverTuple(a), tb = semverTuple(b);
  for (let i = 0; i < 3; i++) if (ta[i] !== tb[i]) return tb[i] - ta[i];
  return 0;
}

/** Best-effort scan of mise's Node installs for one satisfying MIN_NODE_MAJOR,
 *  preferring the highest version found. Returns undefined on any failure
 *  (e.g. mise isn't installed here) — callers fall back to process.execPath. */
export function defaultFindBetterNodeBin(installsDir = path.join(homedir(), '.local/share/mise/installs/node')): string | undefined {
  try {
    const versions = readdirSync(installsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && nodeMajor(d.name) >= MIN_NODE_MAJOR)
      .map((d) => d.name)
      .sort(compareSemver);
    if (!versions.length) return undefined;
    return path.join(installsDir, versions[0], 'bin', 'node');
  } catch {
    return undefined;
  }
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

      let execPath: string = process.execPath;
      const runningVersion = deps.nodeVersion ?? process.version;
      if (nodeMajor(runningVersion) < MIN_NODE_MAJOR) {
        const better = (deps.findBetterNodeBin ?? defaultFindBetterNodeBin)();
        if (better) {
          log.error('respawn: running Node version is too old — using a different interpreter for the replacement', {
            runningVersion, execPath, replacementBin: better, minMajor: MIN_NODE_MAJOR,
          });
          execPath = better;
        } else {
          log.error('respawn: running Node version is too old and no better interpreter was found — respawning with it anyway (best effort)', {
            runningVersion, execPath, minMajor: MIN_NODE_MAJOR,
          });
        }
      }

      let spawnedOk = false;
      try {
        const out = openSync(deps.logFile, 'a');
        const err = openSync(deps.logFile, 'a');
        const child = spawnFn(execPath, [...process.execArgv, ...process.argv.slice(1)], {
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
