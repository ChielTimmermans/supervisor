import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  MM_URL: 'https://mm.example.com',
  MM_TOKEN: 'tok',
  MM_CHANNEL_ID: 'chan',
  WORKER_CONCURRENCY: '2',
  ASK_USER_TIMEOUT_MS: '1000',
  ATTACHMENT_DIR: './scratch',
};
const repos = '{"acme-api":{"path":"/repo/acme","description":"API"}}';

describe('loadConfig', () => {
  it('parses env + repo registry', () => {
    const c = loadConfig(base, repos);
    expect(c.mattermost.url).toBe('https://mm.example.com');
    expect(c.repos['acme-api'].path).toBe('/repo/acme');
    expect(c.workerConcurrency).toBe(2);
    expect(c.askUserTimeoutMs).toBe(1000);
  });

  it('throws when a required field is missing', () => {
    expect(() => loadConfig({ ...base, MM_TOKEN: undefined } as any, repos)).toThrow(/MM_TOKEN/);
  });

  it('defaults concurrency and timeout when absent', () => {
    const c = loadConfig({ ...base, WORKER_CONCURRENCY: undefined, ASK_USER_TIMEOUT_MS: undefined } as any, repos);
    expect(c.workerConcurrency).toBe(3);
    expect(c.investigationConcurrency).toBe(2);
    expect(c.askUserTimeoutMs).toBe(86_400_000);
  });

  it('parses investigationConcurrency from env', () => {
    const c = loadConfig({ ...base, INVESTIGATION_CONCURRENCY: '5' } as any, repos);
    expect(c.investigationConcurrency).toBe(5);
  });

  it('defaults dev-claim TTL and wait timeout when absent', () => {
    const c = loadConfig(base, repos);
    expect(c.devClaimTtlMs).toBe(1_800_000);
    expect(c.devClaimWaitTimeoutMs).toBe(900_000);
  });

  it('parses dev-claim TTL and wait timeout from env', () => {
    const c = loadConfig({ ...base, DEV_CLAIM_TTL_MS: '60000', DEV_CLAIM_WAIT_TIMEOUT_MS: '30000' } as any, repos);
    expect(c.devClaimTtlMs).toBe(60_000);
    expect(c.devClaimWaitTimeoutMs).toBe(30_000);
  });

  it('defaults the watchdog idle and waiting-idle thresholds when absent', () => {
    const c = loadConfig(base, repos);
    expect(c.watchdogIdleMs).toBe(1_200_000);
    expect(c.watchdogWaitingIdleMs).toBe(10_800_000);
  });

  it('parses the watchdog idle and waiting-idle thresholds from env', () => {
    const c = loadConfig({ ...base, WATCHDOG_IDLE_MS: '5000', WATCHDOG_WAITING_IDLE_MS: '9000' } as any, repos);
    expect(c.watchdogIdleMs).toBe(5000);
    expect(c.watchdogWaitingIdleMs).toBe(9000);
  });

  it('defaults maxConsecutiveSilentReconnects to 3 when absent', () => {
    const c = loadConfig(base, repos);
    expect(c.maxConsecutiveSilentReconnects).toBe(3);
  });

  it('parses maxConsecutiveSilentReconnects from env', () => {
    const c = loadConfig({ ...base, MAX_CONSECUTIVE_SILENT_RECONNECTS: '7' } as any, repos);
    expect(c.maxConsecutiveSilentReconnects).toBe(7);
  });

  it('defaults ingest/monitoring config when absent', () => {
    const c = loadConfig(base, repos);
    expect(c.ingestChannels).toEqual([]);
    expect(c.serviceRepoMap).toEqual({});
    expect(c.incidentCooldownMs).toBe(3_600_000);
  });

  it('parses ingest channels, service→repo map, and cooldown', () => {
    const c = loadConfig({
      ...base,
      INGEST_CHANNELS_JSON: '[{"channelId":"c-infra","source":"prometheus"},{"channelId":"c-app","source":"glitchtip"}]',
      SERVICE_REPO_MAP_JSON: '{"console-frontend":"chipmakers"}',
      INCIDENT_COOLDOWN_MS: '5000',
    } as any, repos);
    expect(c.ingestChannels).toEqual([
      { channelId: 'c-infra', source: 'prometheus' },
      { channelId: 'c-app', source: 'glitchtip' },
    ]);
    expect(c.serviceRepoMap['console-frontend']).toBe('chipmakers');
    expect(c.incidentCooldownMs).toBe(5000);
  });
});
