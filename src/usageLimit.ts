/**
 * Detect an Anthropic usage/rate-limit error and, when the message carries one,
 * extract the instant the limit resets. Pure and side-effect free so it can be
 * unit-tested against the exact wire shapes.
 *
 * Returns:
 *  - null                    → not a usage/rate-limit error (caller treats it as terminal)
 *  - { resetAt: Date }       → limit hit; retry at (or just after) resetAt
 *  - { resetAt: null }       → limit hit but no parseable reset time; caller backs off
 */
export interface UsageLimit { resetAt: Date | null }

/** Pull a human-readable message out of whatever the SDK throws. */
function messageOf(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (typeof err === 'object') {
    const o = err as Record<string, unknown>;
    const nested = o.error as Record<string, unknown> | undefined;
    return String(o.message ?? nested?.message ?? o.error ?? '');
  }
  return String(err);
}

// Wording that identifies a usage/rate-limit (as opposed to a genuine bug).
const LIMIT_RE = /usage limit|rate.?limit|\b429\b|too many requests|quota|overloaded/i;

/** Convert a numeric epoch (seconds or milliseconds) to a Date. */
function epochToDate(n: number): Date {
  return new Date(n >= 1e12 ? n : n * 1000);
}

export function parseUsageLimit(err: unknown, now: Date): UsageLimit | null {
  const msg = messageOf(err);
  if (!msg || !LIMIT_RE.test(msg)) return null;

  // 1. Claude's `...usage limit reached|<epoch>` form (seconds or ms).
  const pipe = msg.match(/\|\s*(\d{10,13})\b/);
  if (pipe) return { resetAt: epochToDate(Number(pipe[1])) };

  // 2. A retry-after value in whole seconds.
  const retry = msg.match(/retry.?after["':\s]+(\d+)/i);
  if (retry) return { resetAt: new Date(now.getTime() + Number(retry[1]) * 1000) };

  // 3. An ISO-8601 timestamp anywhere in the message.
  const iso = msg.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?/);
  if (iso) {
    const d = new Date(iso[0]);
    if (!Number.isNaN(d.getTime())) return { resetAt: d };
  }

  // Recognized as a limit, but no reset time to key off — caller backs off.
  return { resetAt: null };
}
