import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { log } from '../src/log.js';

let dir: string;
const saved = { LOG_LEVEL: process.env.LOG_LEVEL, LOG_FILE: process.env.LOG_FILE, LOG_MAX_BYTES: process.env.LOG_MAX_BYTES };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sup-log-'));
  process.env.LOG_LEVEL = 'info';            // override the silent-under-VITEST default
  process.env.LOG_FILE = path.join(dir, 'supervisor.log');
  delete process.env.LOG_MAX_BYTES;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  rmSync(dir, { recursive: true, force: true });
});

describe('durable file logging', () => {
  it('appends a formatted line to LOG_FILE', () => {
    log.info('bridge online', { count: 3 });
    const contents = readFileSync(process.env.LOG_FILE!, 'utf8');
    expect(contents).toMatch(/INFO/);
    expect(contents).toMatch(/bridge online/);
    expect(contents).toMatch(/count=3/);
    expect(contents.endsWith('\n')).toBe(true);
  });

  it('rotates the file to .1 once it exceeds LOG_MAX_BYTES', () => {
    process.env.LOG_MAX_BYTES = '80';
    for (let i = 0; i < 20; i++) log.info(`line number ${i} with some padding text`);
    const rotated = process.env.LOG_FILE! + '.1';
    expect(existsSync(rotated)).toBe(true);
    // The live file was truncated at rotation, so it is smaller than the total written.
    expect(readFileSync(process.env.LOG_FILE!, 'utf8').length).toBeLessThan(20 * 30);
  });

  it('never throws when the log file path is unwritable', () => {
    process.env.LOG_FILE = path.join(dir, 'no-such-subdir', 'deep', 'x.log');
    expect(() => log.error('still fine')).not.toThrow();
  });
});
