import { describe, it, expect } from 'vitest';
import { parseAlert, parsePrometheus, parseGlitchtip, normalizeErrorTitle } from '../src/alerts.js';

const PROM_FIRING = `:red_circle: [FIRING] KubeProxyDown
Target disappeared from Prometheus target discovery.
KubeProxy has disappeared from Prometheus target discovery.

📊 Open Grafana (Infrastructure)`;

const PROM_RESOLVED = `:large_green_circle: [RESOLVED] KubeProxyDown
Target disappeared from Prometheus target discovery.`;

const GLITCH_V1 = `GlitchTip Alert

TypeError: Failed to fetch dynamically imported module: https://console.thechipmakers.dev/chunk-V4Jabc123.js
Project    Environment
console-frontend

development`;

// Same error, different deploy: different chunk hash + URL.
const GLITCH_V2 = `GlitchTip Alert

TypeError: Failed to fetch dynamically imported module: https://console.thechipmakers.dev/chunk-ZZ99xy.js
Project    Environment
console-frontend

development`;

describe('parsePrometheus', () => {
  it('parses a FIRING alert', () => {
    const e = parsePrometheus(PROM_FIRING)!;
    expect(e.status).toBe('firing');
    expect(e.fingerprint).toBe('prometheus:KubeProxyDown');
    expect(e.severity).toBe('critical');
    expect(e.summary).toContain('KubeProxyDown');
    expect(e.summary).toContain('disappeared');
    expect(e.summary).not.toContain('Open Grafana');
  });

  it('parses a RESOLVED alert with the same fingerprint', () => {
    const e = parsePrometheus(PROM_RESOLVED)!;
    expect(e.status).toBe('resolved');
    expect(e.fingerprint).toBe('prometheus:KubeProxyDown');
    expect(e.severity).toBe('ok');
  });

  it('returns null for a non-alert message', () => {
    expect(parsePrometheus('just a normal chat message')).toBeNull();
  });
});

// Flattened form of a webhook post whose alert lives in attachment fields (Key: Value lines).
const GLITCH_ATTACHMENT = `GlitchTip Alert (2 issues)
TypeError: Failed to fetch dynamically imported module: https://console.thechipmakers.dev/chunk-V4Jabc123.js
https://console.thechipmakers.dev/issues/1
Project: console-frontend
Environment: development`;

describe('parseGlitchtip', () => {
  it('parses the error, project, and a firing status', () => {
    const e = parseGlitchtip(GLITCH_V1)!;
    expect(e.status).toBe('firing');
    expect(e.summary).toContain('Failed to fetch dynamically imported module');
    expect(e.service).toBe('console-frontend');
    expect(e.fingerprint.startsWith('glitchtip:')).toBe(true);
  });

  it('extracts the error and service from flattened attachment "Key: Value" fields', () => {
    const e = parseGlitchtip(GLITCH_ATTACHMENT)!;
    expect(e.status).toBe('firing');
    expect(e.summary).toContain('Failed to fetch dynamically imported module');
    expect(e.service).toBe('console-frontend');
  });

  it('de-dups across deploys: same error, different chunk hash → same fingerprint', () => {
    expect(parseGlitchtip(GLITCH_V1)!.fingerprint).toBe(parseGlitchtip(GLITCH_V2)!.fingerprint);
  });
});

describe('normalizeErrorTitle', () => {
  it('strips URLs, chunk hashes, and numbers', () => {
    const a = normalizeErrorTitle('Failed to fetch https://x/chunk-ABC1.js at line 42');
    const b = normalizeErrorTitle('Failed to fetch https://y/chunk-QQ9.js at line 99');
    expect(a).toBe(b);
  });
});

describe('parseAlert dispatch', () => {
  it('routes by source', () => {
    expect(parseAlert('prometheus', PROM_FIRING)?.source).toBe('prometheus');
    expect(parseAlert('glitchtip', GLITCH_V1)?.source).toBe('glitchtip');
  });
});
