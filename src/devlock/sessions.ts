import { execFile } from 'node:child_process';
import { log } from '../log.js';

export function listActiveSessionIds(gcBin = 'gc'): Promise<Set<string>> {
  return new Promise((resolve) => {
    execFile(gcBin, ['session', 'list', '--json'], (err, stdout) => {
      if (err) {
        log.warn('devlock: gc session list failed; reconciling against an empty session set', { error: String(err) });
        resolve(new Set());
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { sessions: Array<{ id: string }> };
        resolve(new Set(parsed.sessions.map((r) => r.id)));
      } catch (parseErr) {
        log.warn('devlock: could not parse gc session list --json output', { error: String(parseErr) });
        resolve(new Set());
      }
    });
  });
}
