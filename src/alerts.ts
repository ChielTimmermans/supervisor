import { createHash } from 'node:crypto';
import type { AlertEvent, AlertSource } from './types.js';

/** Parse an ingest-channel post into an AlertEvent, or null if it isn't a recognizable alert. */
export function parseAlert(source: AlertSource, message: string): AlertEvent | null {
  if (source === 'prometheus') return parsePrometheus(message);
  if (source === 'glitchtip') return parseGlitchtip(message);
  return null;
}

function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function firstUrl(message: string): string | undefined {
  return message.match(/https?:\/\/\S+/)?.[0]?.replace(/[)>.,]+$/, '');
}

/** Read a "Key: value" (or "Key - value") field line from flattened attachment text. */
function fieldValue(lines: string[], key: string): string | undefined {
  const re = new RegExp(`^${key}\\s*[:=\\-]\\s*(.+)$`, 'i');
  for (const l of lines) {
    const m = l.match(re);
    if (m) return m[1].trim() || undefined;
  }
  return undefined;
}

const SEVERITY_BY_EMOJI: Record<string, string> = {
  ':red_circle:': 'critical',
  ':warning:': 'warning',
  ':large_orange_diamond:': 'warning',
  ':large_yellow_circle:': 'warning',
  ':large_green_circle:': 'ok',
};

export function parsePrometheus(message: string): AlertEvent | null {
  const m = message.match(/\[(FIRING|RESOLVED)(?::\d+)?\]\s*(.+)/i);
  if (!m) return null;
  const status = m[1].toUpperCase() === 'RESOLVED' ? 'resolved' : 'firing';
  const alertName = m[2].trim().split(/\s{2,}|\s+—|\s+\|/)[0].trim();

  const lines = message.split(/\r?\n/).map((l) => l.trim());
  const headerIdx = lines.findIndex((l) => /\[(FIRING|RESOLVED)/i.test(l));
  const desc = lines
    .slice(headerIdx + 1)
    .filter((l) => l && !/open grafana|open dashboard/i.test(l) && !/^https?:\/\//.test(l) && !/^[📊📈🔗]/.test(l))
    .join(' ')
    .trim();
  const summary = desc ? `${alertName}: ${desc}` : alertName;

  const emoji = Object.keys(SEVERITY_BY_EMOJI).find((e) => message.includes(e));
  return {
    fingerprint: 'prometheus:' + alertName,
    status,
    source: 'prometheus',
    severity: emoji ? SEVERITY_BY_EMOJI[emoji] : undefined,
    summary,
    sourceUrl: firstUrl(message),
  };
}

/** Strip volatile parts (URLs, chunk hashes, long hex, numbers) so redeploys don't create new incidents. */
export function normalizeErrorTitle(title: string): string {
  return title
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\bchunk[-_][\w-]+/gi, 'chunk')
    .replace(/\b[0-9a-f]{7,}\b/gi, '')
    .replace(/\d+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseGlitchtip(message: string): AlertEvent | null {
  const lines = message.split(/\r?\n/).map((l) => l.trim());
  const nonEmpty = lines.filter(Boolean);
  if (!nonEmpty.length) return null;

  const headerIdx = lines.findIndex((l) => /glitchtip alert/i.test(l));
  const afterHeader = lines.slice(headerIdx + 1).filter(Boolean);
  const errorTitle = (headerIdx >= 0 ? afterHeader[0] : nonEmpty[0]) ?? '';
  if (!errorTitle) return null;

  // Best-effort Project / Environment extraction. Two shapes occur:
  //  (a) a side-by-side grid: "Project    Environment" header, values on the next lines;
  //  (b) flattened attachment fields: "Project: <value>" / "Environment: <value>" per line.
  let service: string | undefined;
  let environment: string | undefined;
  const fieldsIdx = lines.findIndex((l) => /project/i.test(l) && /environment/i.test(l));
  if (fieldsIdx >= 0) {
    const vals = lines
      .slice(fieldsIdx + 1)
      .filter(Boolean)
      .flatMap((l) => l.split(/\s{2,}|\t+/))
      .map((s) => s.trim())
      .filter(Boolean);
    service = vals[0];
    environment = vals[1];
  }
  service ??= fieldValue(lines, 'project');
  environment ??= fieldValue(lines, 'environment');

  const norm = normalizeErrorTitle(errorTitle);
  const key = service ? `${service}|${environment ?? ''}|${norm}` : norm;
  return {
    fingerprint: 'glitchtip:' + shortHash(key),
    status: 'firing', // GlitchTip notifications signal a new/regressed issue
    source: 'glitchtip',
    service,
    summary: errorTitle,
    sourceUrl: firstUrl(message),
  };
}
