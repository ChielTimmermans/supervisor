import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writePidFile, installSelfReload } from '../src/selfReload.js';

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

  it('still respawns and exits even if onReload throws', async () => {
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

  it('exits non-zero instead of hanging silently if the respawn step itself fails', async () => {
    // logFile points inside a directory that doesn't exist, so openSync() throws.
    const badLogFile = path.join(dir, 'no-such-subdir', 'supervisor.log');
    const spawnFn = (() => { throw new Error('should never be reached'); }) as any;
    const exits: number[] = [];

    installSelfReload({
      logFile: badLogFile,
      onReload: async () => {},
      spawnFn,
      exit: (c) => exits.push(c),
    });

    process.emit('SIGHUP');
    await vi.waitFor(() => expect(exits).toEqual([1]));
  });
});
