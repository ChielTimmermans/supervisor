import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installCrashGuards } from '../src/crashGuards.js';

let dir: string;
const saved = { LOG_LEVEL: process.env.LOG_LEVEL, LOG_FILE: process.env.LOG_FILE };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sup-crash-'));
  process.env.LOG_LEVEL = 'error';
  process.env.LOG_FILE = path.join(dir, 'supervisor.log');
});
afterEach(() => {
  process.removeAllListeners('uncaughtException');
  process.removeAllListeners('unhandledRejection');
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  rmSync(dir, { recursive: true, force: true });
});

describe('installCrashGuards', () => {
  it('logs an uncaught exception durably and exits non-zero', () => {
    const exits: number[] = [];
    installCrashGuards({ exit: (c) => exits.push(c) });
    process.emit('uncaughtException', new Error('kaboom'));
    expect(readFileSync(process.env.LOG_FILE!, 'utf8')).toMatch(/uncaughtException.*kaboom/);
    expect(exits).toEqual([1]);
  });

  it('logs an unhandled rejection durably but keeps the process alive', () => {
    const exits: number[] = [];
    installCrashGuards({ exit: (c) => exits.push(c) });
    process.emit('unhandledRejection', new Error('dropped promise'), Promise.resolve());
    expect(readFileSync(process.env.LOG_FILE!, 'utf8')).toMatch(/unhandledRejection.*dropped promise/);
    expect(exits).toEqual([]); // did NOT exit
  });
});
