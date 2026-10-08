import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listActiveSessionIds } from '../../src/devlock/sessions.js';

describe('listActiveSessionIds', () => {
  let dir: string;
  let stubPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'devlock-sessions-'));
    stubPath = join(dir, 'gc');
    writeFileSync(
      stubPath,
      `#!/bin/sh\necho '{"sessions":[{"id":"sess-a"},{"id":"sess-b"}]}'\n`,
    );
    chmodSync(stubPath, 0o755);
  });

  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('parses session ids out of gc session list --json', async () => {
    const ids = await listActiveSessionIds(stubPath);
    expect(ids).toEqual(new Set(['sess-a', 'sess-b']));
  });

  it('returns an empty set if gc is unreachable, without throwing', async () => {
    const ids = await listActiveSessionIds('/no/such/gc');
    expect(ids).toEqual(new Set());
  });
});
