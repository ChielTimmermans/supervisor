import { describe, it, expect } from 'vitest';
import { parseUsageLimit } from '../src/usageLimit.js';

const now = new Date('2026-08-20T12:00:00.000Z');

describe('parseUsageLimit', () => {
  it('returns null for an ordinary, non-limit error', () => {
    expect(parseUsageLimit(new Error('getaddrinfo ENOTFOUND chat.example.com'), now)).toBeNull();
    expect(parseUsageLimit('boom', now)).toBeNull();
    expect(parseUsageLimit(undefined, now)).toBeNull();
  });

  it("parses Claude's `usage limit reached|<unix-epoch-seconds>` reset time", () => {
    const reset = Math.floor(new Date('2026-08-20T15:00:00.000Z').getTime() / 1000);
    const r = parseUsageLimit(new Error(`Claude AI usage limit reached|${reset}`), now);
    expect(r).not.toBeNull();
    expect(r!.resetAt?.toISOString()).toBe('2026-08-20T15:00:00.000Z');
  });

  it('treats a 13-digit pipe value as epoch milliseconds', () => {
    const resetMs = new Date('2026-08-20T15:00:00.000Z').getTime();
    const r = parseUsageLimit(`usage limit reached|${resetMs}`, now);
    expect(r!.resetAt?.toISOString()).toBe('2026-08-20T15:00:00.000Z');
  });

  it('derives resetAt from a retry-after header value in seconds', () => {
    const r = parseUsageLimit(new Error('429 rate limit exceeded; retry-after: 30'), now);
    expect(r).not.toBeNull();
    expect(r!.resetAt?.toISOString()).toBe('2026-08-20T12:00:30.000Z');
  });

  it('derives resetAt from an ISO reset timestamp in the message', () => {
    const r = parseUsageLimit('rate limit reached, resets at 2026-08-20T13:30:00Z', now);
    expect(r!.resetAt?.toISOString()).toBe('2026-08-20T13:30:00.000Z');
  });

  it('recognizes a limit without any parseable time (resetAt null → caller backs off)', () => {
    const r = parseUsageLimit(new Error('HTTP 429 Too Many Requests'), now);
    expect(r).not.toBeNull();
    expect(r!.resetAt).toBeNull();
  });

  it('recognizes "quota" and "overloaded"-style limit wording', () => {
    expect(parseUsageLimit('You have exceeded your quota', now)).not.toBeNull();
  });

  it('reads a message off a structured error object', () => {
    const reset = Math.floor(new Date('2026-08-20T16:00:00.000Z').getTime() / 1000);
    const r = parseUsageLimit({ error: { message: `usage limit reached|${reset}` } }, now);
    expect(r!.resetAt?.toISOString()).toBe('2026-08-20T16:00:00.000Z');
  });
});
