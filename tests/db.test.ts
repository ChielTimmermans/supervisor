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
});
