import { execFile } from 'node:child_process';
import { log } from '../log.js';

export type Notify = (sessionId: string, subject: string, body: string) => Promise<void>;

export function createGcMailNotifier(gcBin = 'gc', timeoutMs = 5000): Notify {
  return (sessionId, subject, body) =>
    new Promise<void>((resolve) => {
      try {
        execFile(
          gcBin,
          ['mail', 'send', sessionId, '-s', subject, '-m', body, '--notify'],
          { timeout: timeoutMs },
          (err) => {
            if (err) log.warn('devlock: gc mail send failed (best-effort, ignoring)', { sessionId, error: String(err) });
            resolve();
          },
        );
      } catch (err) {
        log.warn('devlock: gc mail send threw synchronously (best-effort, ignoring)', { sessionId, error: String(err) });
        resolve();
      }
    });
}
