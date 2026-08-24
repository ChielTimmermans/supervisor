import { describe, it, expect, beforeEach } from 'vitest';
import { Db } from '../src/db.js';
import { DevEnvLocks } from '../src/devEnvLocks.js';

/** Deterministic timer harness: control `now` and fire due timers by hand. */
function harness() {
  let now = 0;
  let seq = 0;
  const timers: Array<{ id: number; fn: () => void; at: number; dead: boolean }> = [];
  const schedule = (fn: () => void, ms: number) => {
    const id = ++seq;
    timers.push({ id, fn, at: now + ms, dead: false });
    return () => { const t = timers.find((t) => t.id === id); if (t) t.dead = true; };
  };
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers.filter((t) => !t.dead && t.at <= now).sort((a, b) => a.at - b.at)) {
      t.dead = true; t.fn();
    }
  };
  return { schedule, now: () => now, advance };
}

function make(opts?: { ttlMs?: number; waitTimeoutMs?: number }) {
  const db = new Db(':memory:');
  const h = harness();
  const locks = new DevEnvLocks(db, {
    ttlMs: opts?.ttlMs ?? 1000,
    waitTimeoutMs: opts?.waitTimeoutMs ?? 500,
    now: h.now,
    schedule: h.schedule,
  });
  return { db, locks, h };
}

describe('DevEnvLocks', () => {
  it('grants a free env and is reentrant for the holder', () => {
    const { db, locks } = make();
    expect(locks.claim('acme', 'w1', 't1').status).toBe('granted');
    expect(db.getDevClaim('acme')?.workerId).toBe('w1');
    // same worker re-claiming is a no-op success, still the holder
    expect(locks.claim('acme', 'w1', 't1').status).toBe('granted');
    expect(db.getDevClaim('acme')?.workerId).toBe('w1');
  });

  it('a second worker gets busy, then is promoted FIFO when the holder releases', async () => {
    const { db, locks } = make();
    locks.claim('acme', 'w1', 't1');

    const b = locks.claim('acme', 'w2', 't2');
    expect(b.status).toBe('busy');
    if (b.status !== 'busy') throw new Error('unreachable');
    const waitB = locks.waitFor(b.ticket);

    // release by holder promotes w2
    const rel = locks.release('acme', 'w1');
    expect(rel.released).toBe(true);
    expect(rel.promoted?.workerId).toBe('w2');
    expect(db.getDevClaim('acme')?.workerId).toBe('w2');
    expect(await waitB).toEqual({ status: 'granted' });
  });

  it('promotes waiters in FIFO order', async () => {
    const { db, locks } = make();
    locks.claim('acme', 'w1', 't1');
    const b = locks.claim('acme', 'w2', 't2');
    const c = locks.claim('acme', 'w3', 't3');
    if (b.status !== 'busy' || c.status !== 'busy') throw new Error('expected busy');
    const waitB = locks.waitFor(b.ticket);
    const waitC = locks.waitFor(c.ticket);

    locks.release('acme', 'w1');
    expect(db.getDevClaim('acme')?.workerId).toBe('w2');
    expect(await waitB).toEqual({ status: 'granted' });

    locks.release('acme', 'w2');
    expect(db.getDevClaim('acme')?.workerId).toBe('w3');
    expect(await waitC).toEqual({ status: 'granted' });
  });

  it('release by a non-holder is a no-op', () => {
    const { locks } = make();
    locks.claim('acme', 'w1', 't1');
    const rel = locks.release('acme', 'w2');
    expect(rel.released).toBe(false);
    expect(rel.promoted).toBeUndefined();
  });

  it('a waiter times out after waitTimeoutMs and returns control, leaving the holder in place', async () => {
    const { db, locks, h } = make({ ttlMs: 100_000, waitTimeoutMs: 500 });
    locks.claim('acme', 'w1', 't1');
    const b = locks.claim('acme', 'w2', 't2');
    if (b.status !== 'busy') throw new Error('expected busy');
    const waitB = locks.waitFor(b.ticket);

    h.advance(500);
    expect(await waitB).toEqual({ status: 'timeout' });
    // holder unchanged; w2 no longer queued
    expect(db.getDevClaim('acme')?.workerId).toBe('w1');
  });

  it('a fresh claim breaks a stale claim when no one is waiting', () => {
    const { db, locks, h } = make({ ttlMs: 1000 });
    locks.claim('acme', 'w1', 't1');
    h.advance(1001); // w1's claim is now stale
    const c = locks.claim('acme', 'w3', 't3');
    expect(c.status).toBe('granted-broke-stale');
    if (c.status === 'granted-broke-stale') expect(c.prior.workerId).toBe('w1');
    expect(db.getDevClaim('acme')?.workerId).toBe('w3');
  });

  it('the head waiter auto-breaks a stale holder via its stale timer', async () => {
    const { db, locks, h } = make({ ttlMs: 1000, waitTimeoutMs: 100_000 });
    locks.claim('acme', 'w1', 't1');
    const b = locks.claim('acme', 'w2', 't2');
    if (b.status !== 'busy') throw new Error('expected busy');
    const waitB = locks.waitFor(b.ticket);

    h.advance(1000); // holder becomes stale → head's stale timer fires
    const res = await waitB;
    expect(res.status).toBe('granted');
    if (res.status === 'granted') expect(res.brokeStale?.workerId).toBe('w1');
    expect(db.getDevClaim('acme')?.workerId).toBe('w2');
  });

  it('a fresh claim does NOT jump ahead of existing waiters, even to break a stale holder', async () => {
    const { db, locks, h } = make({ ttlMs: 1000, waitTimeoutMs: 100_000 });
    locks.claim('acme', 'w1', 't1');
    const b = locks.claim('acme', 'w2', 't2'); // B waits (head)
    if (b.status !== 'busy') throw new Error('expected busy');
    const waitB = locks.waitFor(b.ticket);

    h.advance(1001); // w1 stale now
    const c = locks.claim('acme', 'w3', 't3'); // C arrives AFTER B
    expect(c.status).toBe('busy'); // must not jump B
    if (c.status !== 'busy') throw new Error('unreachable');
    const waitC = locks.waitFor(c.ticket);

    // B's stale timer (scheduled at enqueue for the ttl boundary) promotes B, not C
    h.advance(0); // fire any due timers at current time
    expect((await waitB).status).toBe('granted');
    expect(db.getDevClaim('acme')?.workerId).toBe('w2');

    // C still waiting behind B
    locks.release('acme', 'w2');
    expect((await waitC).status).toBe('granted');
    expect(db.getDevClaim('acme')?.workerId).toBe('w3');
  });

  it('releaseAllFor frees every claim a worker holds and hands off to waiters', async () => {
    const { db, locks } = make();
    locks.claim('acme', 'w1', 't1');
    locks.claim('beta', 'w1', 't1');
    const b = locks.claim('acme', 'w2', 't2');
    if (b.status !== 'busy') throw new Error('expected busy');
    const waitB = locks.waitFor(b.ticket);

    locks.releaseAllFor('w1');
    expect(db.getDevClaim('beta')).toBeUndefined();      // freed, no waiter
    expect(db.getDevClaim('acme')?.workerId).toBe('w2');  // handed off
    expect(await waitB).toEqual({ status: 'granted' });
  });

  it('releaseAllFor removes a torn-down worker that was only waiting', async () => {
    const { db, locks } = make();
    locks.claim('acme', 'w1', 't1');
    const b = locks.claim('acme', 'w2', 't2');
    if (b.status !== 'busy') throw new Error('expected busy');
    const waitB = locks.waitFor(b.ticket);

    locks.releaseAllFor('w2'); // w2 torn down while waiting
    expect(await waitB).toEqual({ status: 'timeout' });
    // w1 still holds; releasing it now frees the env (no phantom waiter)
    const rel = locks.release('acme', 'w1');
    expect(rel.promoted).toBeUndefined();
    expect(db.getDevClaim('acme')).toBeUndefined();
  });

  it('reconcile drops claims whose holder is no longer active', () => {
    const { db, locks } = make();
    locks.claim('acme', 'w1', 't1');
    locks.claim('beta', 'w2', 't2');
    locks.reconcile((id) => id === 'w1'); // only w1 still active
    expect(db.getDevClaim('acme')?.workerId).toBe('w1');
    expect(db.getDevClaim('beta')).toBeUndefined();
  });

  it('forceRelease breaks a claim and hands off to the next waiter', async () => {
    const { db, locks } = make();
    locks.claim('acme', 'w1', 't1');
    const b = locks.claim('acme', 'w2', 't2');
    if (b.status !== 'busy') throw new Error('expected busy');
    const waitB = locks.waitFor(b.ticket);

    const fr = locks.forceRelease('acme');
    expect(fr.prior?.workerId).toBe('w1');
    expect(fr.promoted?.workerId).toBe('w2');
    expect((await waitB).status).toBe('granted');
    expect(db.getDevClaim('acme')?.workerId).toBe('w2');
  });
});
