export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const RANK: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

// Read the threshold per call so it picks up LOG_LEVEL after dotenv loads,
// regardless of module init order. Defaults to `info`, or `silent` under tests.
function threshold(): number {
  const env = (process.env.LOG_LEVEL ?? '').toLowerCase();
  if (env && env in RANK) return RANK[env as LogLevel];
  if (process.env.VITEST) return RANK.silent;
  return RANK.info;
}

/** Collapse whitespace and truncate for single-line log context. */
export function preview(text: string, max = 120): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max) + '…' : one;
}

function fmt(v: unknown): string {
  if (typeof v === 'string') return /\s/.test(v) ? JSON.stringify(v) : v;
  return String(v);
}

function emit(level: Exclude<LogLevel, 'silent'>, msg: string, ctx?: Record<string, unknown>): void {
  if (RANK[level] > threshold()) return;
  const time = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const tag = level.toUpperCase().padEnd(5);
  const suffix = ctx && Object.keys(ctx).length
    ? ' ' + Object.entries(ctx).map(([k, v]) => `${k}=${fmt(v)}`).join(' ')
    : '';
  const write = level === 'error' || level === 'warn' ? console.error : console.log;
  write(`${time} ${tag} ${msg}${suffix}`);
}

export const log = {
  error: (msg: string, ctx?: Record<string, unknown>) => emit('error', msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => emit('warn', msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => emit('info', msg, ctx),
  debug: (msg: string, ctx?: Record<string, unknown>) => emit('debug', msg, ctx),
};
