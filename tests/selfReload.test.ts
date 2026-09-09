import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writePidFile, installSelfReload, defaultFindBetterNodeBin } from '../src/selfReload.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'sup-reload-')); });
afterEach(() => { process.removeAllListeners('SIGHUP'); rmSync(dir, { recursive: true, force: true }); });

describe('writePidFile', () => {
  it('writes the current process pid to the given file', () => {
    const pidFile = path.join(dir, 'supervisor.pid');
    writePidFile(pidFile);
    expect(readFileSync(pidFile, 'utf8')).toBe(String(process.pid));
  });
});

describe('defaultFindBetterNodeBin', () => {
  it('picks the highest full semver version, not just the highest major (ties on major happen: mise commonly holds two installs of one major mid-upgrade)', () => {
    for (const v of ['20.20.2', '24.18.0', '24.19.0']) mkdirSync(path.join(dir, v, 'bin'), { recursive: true });
    expect(defaultFindBetterNodeBin(dir)).toBe(path.join(dir, '24.19.0', 'bin', 'node'));
  });

  it('returns undefined when no installed version satisfies the minimum', () => {
    for (const v of ['18.19.1', '20.20.2']) mkdirSync(path.join(dir, v, 'bin'), { recursive: true });
    expect(defaultFindBetterNodeBin(dir)).toBeUndefined();
  });

  it('returns undefined when the installs dir does not exist', () => {
    expect(defaultFindBetterNodeBin(path.join(dir, 'no-such-dir'))).toBeUndefined();
  });
});

describe('installSelfReload', () => {
  it('on SIGHUP: runs onReload, spawns a detached replacement, then exits', async () => {
    const calls: any[] = [];
    const spawnFn = ((cmd: string, args: string[], opts: any) => {
      calls.push({ cmd, args, opts });
      return { unref: () => {}, pid: 4242 } as any;
    }) as any;
    const exits: number[] = [];
    let reloaded = false;

    installSelfReload({
      logFile: path.join(dir, 'supervisor.log'),
      onReload: async () => { reloaded = true; },
      spawnFn,
      exit: (c) => exits.push(c),
    });

    process.emit('SIGHUP');
    await vi.waitFor(() => expect(exits).toEqual([0]));

    expect(reloaded).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe(process.execPath);
    expect(calls[0].opts.detached).toBe(true);
  });

  it('spawns the replacement BEFORE running onReload, not after', async () => {
    // A real incident: onReload (stopping live sessions + closing the gateway/DB)
    // crashed the process silently, with no JS-level error — before this change,
    // that meant the replacement was never spawned and nothing was ever running
    // again. Spawning first means even if onReload then brings the process down,
    // a replacement is already on the way.
    const order: string[] = [];
    const spawnFn = ((_cmd: string, _args: string[], _opts: any) => { order.push('spawn'); return { unref: () => {}, pid: 1 } as any; }) as any;
    let resolveReload!: () => void;
    const gate = new Promise<void>((r) => (resolveReload = r));
    const exits: number[] = [];

    installSelfReload({
      logFile: path.join(dir, 'supervisor.log'),
      onReload: () => { order.push('onReload-start'); return gate.then(() => { order.push('onReload-done'); }); },
      spawnFn,
      exit: (c) => exits.push(c),
    });

    process.emit('SIGHUP');

    // The replacement must already be spawned while onReload is still pending.
    await vi.waitFor(() => expect(order).toEqual(['spawn', 'onReload-start']));

    resolveReload();
    await vi.waitFor(() => expect(exits).toEqual([0]));
    expect(order).toEqual(['spawn', 'onReload-start', 'onReload-done']);
  });

  it('passes SUPERVISOR_RESPAWNED=1 in the replacement process env', async () => {
    // The replacement's own startup (index.ts) uses this to wait past the old
    // process's SIGTERM->SIGKILL escalation window before resuming any sessions,
    // so it doesn't race the old process's dying children for the same session ids.
    const calls: any[] = [];
    const spawnFn = ((cmd: string, args: string[], opts: any) => { calls.push(opts); return { unref: () => {}, pid: 1 } as any; }) as any;
    const exits: number[] = [];

    installSelfReload({
      logFile: path.join(dir, 'supervisor.log'),
      onReload: async () => {},
      spawnFn,
      exit: (c) => exits.push(c),
    });

    process.emit('SIGHUP');
    await vi.waitFor(() => expect(exits).toEqual([0]));

    expect(calls).toHaveLength(1);
    expect(calls[0].env.SUPERVISOR_RESPAWNED).toBe('1');
  });

  it('ignores a second SIGHUP received while a reload is already in progress', async () => {
    const calls: unknown[] = [];
    const spawnFn = ((cmd: string, args: string[], opts: any) => { calls.push(1); return { unref: () => {}, pid: 1 } as any; }) as any;
    const exits: number[] = [];
    let resolveReload!: () => void;
    const gate = new Promise<void>((r) => (resolveReload = r));

    installSelfReload({
      logFile: path.join(dir, 'supervisor.log'),
      onReload: () => gate,
      spawnFn,
      exit: (c) => exits.push(c),
    });

    process.emit('SIGHUP');
    process.emit('SIGHUP'); // arrives while still shutting down — must be ignored
    resolveReload();

    await vi.waitFor(() => expect(exits).toEqual([0]));
    expect(calls).toHaveLength(1);
  });

  it('still exits 0 after a successful respawn even if onReload throws', async () => {
    const calls: unknown[] = [];
    const spawnFn = ((cmd: string, args: string[], opts: any) => { calls.push(1); return { unref: () => {}, pid: 1 } as any; }) as any;
    const exits: number[] = [];

    installSelfReload({
      logFile: path.join(dir, 'supervisor.log'),
      onReload: async () => { throw new Error('boom'); },
      spawnFn,
      exit: (c) => exits.push(c),
    });

    process.emit('SIGHUP');
    await vi.waitFor(() => expect(exits).toEqual([0]));
    expect(calls).toHaveLength(1);
  });

  it('respawns with process.execPath when the running node version satisfies the minimum', async () => {
    const calls: any[] = [];
    const spawnFn = ((cmd: string, args: string[], opts: any) => { calls.push({ cmd, args, opts }); return { unref: () => {}, pid: 1 } as any; }) as any;

    installSelfReload({
      logFile: path.join(dir, 'supervisor.log'),
      onReload: async () => {},
      spawnFn,
      exit: () => {},
      nodeVersion: 'v22.0.0',
      findBetterNodeBin: () => { throw new Error('should not be called — the running version is already fine'); },
    });

    process.emit('SIGHUP');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].cmd).toBe(process.execPath);
  });

  it('respawns with findBetterNodeBin\'s result instead of process.execPath when the running node version is too old', async () => {
    // Real incident: a SIGHUP respawn ran under a stray Node v18.19.1
    // (process.execPath was NOT the mise-managed interpreter), which crashed
    // immediately (`Client4` export not found under an old package resolution)
    // and cascaded into a ~1h crash loop only recovered by the external
    // watchdog. process.execPath is whatever binary happened to launch THIS
    // process — self-reload must not blindly trust it forever.
    const calls: any[] = [];
    const spawnFn = ((cmd: string, args: string[], opts: any) => { calls.push({ cmd, args, opts }); return { unref: () => {}, pid: 1 } as any; }) as any;

    installSelfReload({
      logFile: path.join(dir, 'supervisor.log'),
      onReload: async () => {},
      spawnFn,
      exit: () => {},
      nodeVersion: 'v18.19.1',
      findBetterNodeBin: () => '/opt/node22/bin/node',
    });

    process.emit('SIGHUP');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].cmd).toBe('/opt/node22/bin/node');
  });

  it('falls back to process.execPath (best effort) when the node version is too old and no better binary is found', async () => {
    const calls: any[] = [];
    const spawnFn = ((cmd: string, args: string[], opts: any) => { calls.push({ cmd, args, opts }); return { unref: () => {}, pid: 1 } as any; }) as any;
    const exits: number[] = [];

    installSelfReload({
      logFile: path.join(dir, 'supervisor.log'),
      onReload: async () => {},
      spawnFn,
      exit: (c) => exits.push(c),
      nodeVersion: 'v18.19.1',
      findBetterNodeBin: () => undefined,
    });

    process.emit('SIGHUP');
    await vi.waitFor(() => expect(exits).toEqual([0]));
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe(process.execPath);
  });

  it('exits non-zero if the respawn step itself fails, but still attempts onReload', async () => {
    // logFile points inside a directory that doesn't exist, so openSync() throws.
    const badLogFile = path.join(dir, 'no-such-subdir', 'supervisor.log');
    const spawnFn = (() => { throw new Error('should never be reached'); }) as any;
    const exits: number[] = [];
    let reloaded = false;

    installSelfReload({
      logFile: badLogFile,
      onReload: async () => { reloaded = true; },
      spawnFn,
      exit: (c) => exits.push(c),
    });

    process.emit('SIGHUP');
    await vi.waitFor(() => expect(exits).toEqual([1]));
    // No replacement is coming, but the live sessions/gateway/DB still get a
    // chance to stop cleanly rather than being abandoned outright.
    expect(reloaded).toBe(true);
  });
});
