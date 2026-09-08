import { readdirSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';

// Started once at module load so .mean/.max reflect the process's whole
// lifetime, not just since the last read.
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

export interface ProcessDiagnostics {
  rssMb: number;
  heapUsedMb: number;
  openFds?: number;
  activeHandles?: number;
  activeRequests?: number;
  eventLoopDelayMeanMs?: number;
  eventLoopDelayMaxMs?: number;
}

/**
 * A snapshot of this process's own resource usage, for logging at a moment
 * something looks wrong (e.g. the session watchdog firing) — evidence for
 * whether a hang correlates with leaked handles/fds or event-loop pressure,
 * rather than guessing from outside the process after the fact.
 */
export function processDiagnostics(): ProcessDiagnostics {
  const mem = process.memoryUsage();
  const out: ProcessDiagnostics = {
    rssMb: Math.round(mem.rss / 1024 / 1024),
    heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
  };
  try { out.openFds = readdirSync('/proc/self/fd').length; } catch { /* non-Linux — best-effort only */ }
  try {
    const p = process as unknown as { _getActiveHandles?: () => unknown[]; _getActiveRequests?: () => unknown[] };
    if (p._getActiveHandles) out.activeHandles = p._getActiveHandles().length;
    if (p._getActiveRequests) out.activeRequests = p._getActiveRequests().length;
  } catch { /* undocumented Node internals — best-effort only */ }
  try {
    if (Number.isFinite(loopDelay.mean)) out.eventLoopDelayMeanMs = Math.round(loopDelay.mean / 1e6);
    if (Number.isFinite(loopDelay.max)) out.eventLoopDelayMaxMs = Math.round(loopDelay.max / 1e6);
  } catch { /* histogram unsupported — best-effort only */ }
  return out;
}
