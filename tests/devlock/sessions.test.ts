import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listActiveSessionIds } from '../../src/devlock/sessions.js';

describe('listActiveSessionIds', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'devlock-sessions-'));
  });

  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  function stub(name: string, script: string): string {
    const stubPath = join(dir, name);
    writeFileSync(stubPath, script);
    chmodSync(stubPath, 0o755);
    return stubPath;
  }

  it('passes --state active and parses only active, non-closed session ids out of gc session list --json', async () => {
    // Echo back the args it was called with (as a JSON comment line) plus a mixed-state
    // session list, so the test can assert both the invocation and the client-side filter.
    const stubPath = stub(
      'gc-mixed',
      `#!/bin/sh\n` +
        `echo "$@" > "${join(dir, 'gc-mixed.args')}"\n` +
        `echo '{"sessions":[` +
        `{"id":"sess-active","state":"active","closed":false},` +
        `{"id":"sess-suspended","state":"suspended","closed":false},` +
        `{"id":"sess-closed","state":"active","closed":true},` +
        `{"id":"sess-active-2","state":"active"}` +
        `]}'\n`,
    );

    const ids = await listActiveSessionIds(stubPath);
    expect(ids).toEqual(new Set(['sess-active', 'sess-active-2']));

    const args = readFileSync(join(dir, 'gc-mixed.args'), 'utf8').trim();
    expect(args).toBe('session list --json --state active');
  });

  it('returns an empty set (not null) when gc genuinely reports zero active sessions', async () => {
    const stubPath = stub('gc-empty', `#!/bin/sh\necho '{"sessions":[]}'\n`);
    const ids = await listActiveSessionIds(stubPath);
    expect(ids).toEqual(new Set());
  });

  it('returns null (not an empty set) if gc is unreachable, so callers can tell "unknown" from "zero"', async () => {
    const ids = await listActiveSessionIds('/no/such/gc');
    expect(ids).toBeNull();
  });

  it('returns null if gc produces unparseable output', async () => {
    const stubPath = stub('gc-garbage', `#!/bin/sh\necho 'not json'\n`);
    const ids = await listActiveSessionIds(stubPath);
    expect(ids).toBeNull();
  });
});
