import { execFile } from 'node:child_process';
import { log } from '../log.js';

/**
 * Query `gc` for the set of currently-active session ids.
 *
 * Returns `null` when the query itself failed (missing binary, not run from
 * inside a city dir, malformed JSON) — callers must treat that as "couldn't
 * determine" and NOT reconcile against it, since an empty Set would otherwise
 * be indistinguishable from "genuinely queried and found zero active sessions"
 * and would cause every persisted dev-env claim to be force-released.
 */
export function listActiveSessionIds(gcBin = 'gc'): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    execFile(gcBin, ['session', 'list', '--json', '--state', 'active'], (err, stdout) => {
      if (err) {
        log.warn('devlock: gc session list failed; cannot determine active sessions', { error: String(err) });
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { sessions: Array<{ id: string; state?: string; closed?: boolean }> };
        const ids = parsed.sessions
          .filter((r) => r.state === 'active' && !r.closed)
          .map((r) => r.id);
        resolve(new Set(ids));
      } catch (parseErr) {
        log.warn('devlock: could not parse gc session list --json output', { error: String(parseErr) });
        resolve(null);
      }
    });
  });
}
