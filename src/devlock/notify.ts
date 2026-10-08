import { execFile } from 'node:child_process';
import { log } from '../log.js';

export type Notify = (sessionId: string, subject: string, body: string) => Promise<void>;

export function createGcMailNotifier(gcBin = 'gc'): Notify {
  return (sessionId, subject, body) =>
    new Promise<void>((resolve) => {
      execFile(gcBin, ['mail', 'send', sessionId, '-s', subject, '-m', body, '--notify'], (err) => {
        if (err) log.warn('devlock: gc mail send failed (best-effort, ignoring)', { sessionId, error: String(err) });
        resolve();
      });
    });
}
