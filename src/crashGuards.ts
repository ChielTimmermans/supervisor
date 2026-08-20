import { log } from './log.js';

function errMsg(e: unknown): string {
  return e instanceof Error ? (e.stack ?? e.message) : String(e);
}

/**
 * Last-resort process guards so a stray error leaves a durable record instead of
 * a silent death. `log.error` writes synchronously to LOG_FILE, so the reason is
 * on disk before we (possibly) exit.
 *
 * - unhandledRejection: log and KEEP RUNNING. Post handling is already guarded
 *   (bridge wraps each post), so one dropped promise shouldn't take the bot down.
 * - uncaughtException: log and exit non-zero — the process is in an unknown state,
 *   so let the supervisor (tmux/systemd) restart it clean.
 */
export function installCrashGuards(opts?: { exit?: (code: number) => void }): void {
  const exit = opts?.exit ?? ((c: number) => process.exit(c));
  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection (kept alive)', { err: errMsg(reason) });
  });
  process.on('uncaughtException', (err) => {
    log.error('uncaughtException — exiting for a clean restart', { err: errMsg(err) });
    exit(1);
  });
}
