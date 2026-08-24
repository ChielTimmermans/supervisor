import { describe, it, expect, beforeEach } from 'vitest';
import { Db } from '../src/db.js';

let db: Db;
beforeEach(() => { db = new Db(':memory:'); });

describe('Db', () => {
  it('creates and reads a worker by id and thread', () => {
    const w = db.createWorker({ id: 'w1', threadRootId: 't1', repoName: 'acme', repoPath: '/r/acme', task: 'do x' });
    expect(w.status).toBe('running');
    expect(db.getWorker('w1')?.task).toBe('do x');
    expect(db.getWorkerByThread('t1')?.id).toBe('w1');
  });

  it('updates session id and status', () => {
    db.createWorker({ id: 'w1', threadRootId: 't1', repoName: 'a', repoPath: '/a', task: 't' });
    db.updateWorker('w1', { sessionId: 's1', status: 'waiting' });
    const w = db.getWorker('w1')!;
    expect(w.sessionId).toBe('s1');
    expect(w.status).toBe('waiting');
  });

  it('tracks pending questions per worker', () => {
    db.createWorker({ id: 'w1', threadRootId: 't1', repoName: 'a', repoPath: '/a', task: 't' });
    db.addPendingQuestion({ id: 'q1', workerId: 'w1', questionPostId: 'p1' });
    expect(db.getOpenQuestionForWorker('w1')?.id).toBe('q1');
    db.resolvePendingQuestion('q1', 'the answer');
    expect(db.getOpenQuestionForWorker('w1')).toBeUndefined();
  });

  it('stores meta key/values', () => {
    db.setMeta('supervisor_session', 's-123');
    expect(db.getMeta('supervisor_session')).toBe('s-123');
  });

  it('creates and de-dups incidents by fingerprint', () => {
    const inc = db.createIncident({
      id: 'i1', fingerprint: 'KubeProxyDown', source: 'prometheus', service: null,
      repoName: null, threadRootId: 't-inc', workerId: 'w1', summary: 'proxy down',
    });
    expect(inc.status).toBe('open');
    expect(inc.refireCount).toBe(1);
    expect(db.getOpenIncidentByFingerprint('KubeProxyDown')?.id).toBe('i1');
    expect(db.getIncidentByThread('t-inc')?.id).toBe('i1');

    db.recordRefire('i1');
    expect(db.getIncident('i1')!.refireCount).toBe(2);

    expect(db.listOpenIncidents().map((x) => x.id)).toEqual(['i1']);

    db.setIncidentStatus('i1', 'closed');
    expect(db.getOpenIncidentByFingerprint('KubeProxyDown')).toBeUndefined();
    expect(db.listOpenIncidents()).toEqual([]);
  });

  it('holds a dev claim exclusively per repo and releases it', () => {
    expect(db.tryClaimDev('acme', 'w1', 't1', 100)).toBe(true);
    // second worker cannot claim the same repo
    expect(db.tryClaimDev('acme', 'w2', 't2', 200)).toBe(false);
    // a different repo is independent
    expect(db.tryClaimDev('other', 'w2', 't2', 200)).toBe(true);
    expect(db.getDevClaim('acme')).toEqual({ repoName: 'acme', workerId: 'w1', threadRootId: 't1', claimedAt: 100 });

    // non-holder release is a no-op; holder release works
    expect(db.releaseDevClaim('acme', 'w2')).toBe(false);
    expect(db.releaseDevClaim('acme', 'w1')).toBe(true);
    expect(db.getDevClaim('acme')).toBeUndefined();
    // now free to claim
    expect(db.tryClaimDev('acme', 'w2', 't2', 300)).toBe(true);
  });

  it('force-sets, force-releases, and bulk-removes claims by worker', () => {
    db.tryClaimDev('acme', 'w1', 't1', 100);
    db.tryClaimDev('beta', 'w1', 't1', 100);
    db.tryClaimDev('gamma', 'w2', 't2', 100);

    // force-set overwrites the holder (stale break / handoff)
    db.forceSetDevClaim('acme', 'w3', 't3', 500);
    expect(db.getDevClaim('acme')?.workerId).toBe('w3');

    // force-release returns the prior holder
    expect(db.forceReleaseDevClaim('gamma')?.workerId).toBe('w2');
    expect(db.getDevClaim('gamma')).toBeUndefined();

    // bulk remove by worker returns removed claims
    const removed = db.deleteDevClaimsByWorker('w1').map((c) => c.repoName).sort();
    expect(removed).toEqual(['beta']); // acme was reassigned to w3
    expect(db.listDevClaims().map((c) => c.repoName).sort()).toEqual(['acme']);
  });

  it('creates a queued incident and lists it, then assigns a worker to open it', () => {
    const inc = db.createIncident({
      id: 'q1', fingerprint: 'OOM', source: 'prometheus', service: null,
      repoName: null, threadRootId: 't-q', workerId: null, summary: 'oom', status: 'queued',
    });
    expect(inc.status).toBe('queued');
    expect(inc.workerId).toBeNull();
    // still dedups re-fires (non-closed) and shows in open list
    expect(db.getOpenIncidentByFingerprint('OOM')?.id).toBe('q1');
    expect(db.listQueuedIncidents().map((x) => x.id)).toEqual(['q1']);

    db.assignIncidentWorker('q1', 'w-drained');
    const opened = db.getIncident('q1')!;
    expect(opened.status).toBe('open');
    expect(opened.workerId).toBe('w-drained');
    expect(db.listQueuedIncidents()).toEqual([]);
  });
});
