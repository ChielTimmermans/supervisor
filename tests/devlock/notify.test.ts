import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGcMailNotifier } from '../../src/devlock/notify.js';

describe('createGcMailNotifier', () => {
  let dir: string;
  let logPath: string;
  let stubPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'devlock-notify-'));
    logPath = join(dir, 'calls.log');
    stubPath = join(dir, 'gc');
    writeFileSync(stubPath, `#!/bin/sh\necho "$@" >> "${logPath}"\n`);
    chmodSync(stubPath, 0o755);
  });

  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('invokes gc mail send with --notify and the recipient session id', async () => {
    const notify = createGcMailNotifier(stubPath);
    await notify('sess-b', 'dev-env', 'Your claim was broken.');
    const calls = readFileSync(logPath, 'utf8').trim();
    expect(calls).toBe('mail send sess-b -s dev-env -m Your claim was broken. --notify');
  });

  it('does not throw when the gc binary is missing', async () => {
    const notify = createGcMailNotifier('/no/such/gc');
    await expect(notify('sess-b', 'dev-env', 'hi')).resolves.toBeUndefined();
  });

  it('resolves (does not hang) when the gc process hangs past the timeout', async () => {
    const hangStub = join(dir, 'gc-hang');
    writeFileSync(hangStub, `#!/bin/sh\nsleep 5\n`);
    chmodSync(hangStub, 0o755);

    const notify = createGcMailNotifier(hangStub, 50);
    const start = Date.now();
    await expect(notify('sess-b', 'dev-env', 'hi')).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
