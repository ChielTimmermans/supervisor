import type { Db } from './db.js';
import type { DevClaim } from './types.js';

export type WaitResult = { status: 'granted'; brokeStale?: DevClaim } | { status: 'timeout' };

export type ClaimResult =
  | { status: 'granted' }
  | { status: 'granted-broke-stale'; prior: DevClaim }
  | { status: 'busy'; holder: DevClaim; ticket: DevClaimTicket };

/** Opaque handle returned by `claim` when the env is busy; pass it to `waitFor`. */
export interface DevClaimTicket {
  repo: string;
  workerId: string;
  threadRootId: string;
  resolve?: (r: WaitResult) => void;
  settled?: WaitResult;
  staleCancel?: () => void;
  waitCancel?: () => void;
}

export interface DevEnvLocksOpts {
  ttlMs: number;
  waitTimeoutMs: number;
  now?: () => number;
  /** Schedule a callback; returns a canceler. Injectable so tests can drive timers deterministically. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

/**
 * Cross-worker mutual exclusion on each repo's shared dev environment.
 *
 * The DB is the source of truth for *who holds* a repo (survives restart); the FIFO
 * *waiter queue* is in-memory (live Promise resolvers can't be persisted). One worker
 * holds a repo at a time; others queue and are promoted in order on release. A holder
 * that overruns `ttlMs` is "stale" and may be broken — either by a fresh claimant when
 * no one is waiting, or by the head waiter's stale timer — so a stuck holder can't wedge
 * the queue forever. A waiter that blocks past `waitTimeoutMs` gives up and returns control.
 */
export class DevEnvLocks {
  private queues = new Map<string, DevClaimTicket[]>();
  private readonly ttlMs: number;
  private readonly waitTimeoutMs: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;

  constructor(private db: Db, opts: DevEnvLocksOpts) {
    this.ttlMs = opts.ttlMs;
    this.waitTimeoutMs = opts.waitTimeoutMs;
    this.now = opts.now ?? (() => Date.now());
    this.schedule = opts.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
  }

  /** Attempt to acquire the repo's dev env. Returns granted, granted-broke-stale, or busy (with a ticket to wait on). */
  claim(repo: string, workerId: string, threadRootId: string): ClaimResult {
    const holder = this.db.getDevClaim(repo);
    if (holder?.workerId === workerId) return { status: 'granted' }; // reentrant
    const queue = this.queues.get(repo) ?? [];

    if (!holder) {
      this.db.tryClaimDev(repo, workerId, threadRootId, this.now());
      return { status: 'granted' };
    }

    // Held by someone else. A fresh claimant may break a stale holder only when no one is
    // already waiting — otherwise it would jump the queue.
    if (this.isStale(holder) && queue.length === 0) {
      this.db.forceSetDevClaim(repo, workerId, threadRootId, this.now());
      return { status: 'granted-broke-stale', prior: holder };
    }

    const ticket: DevClaimTicket = { repo, workerId, threadRootId };
    queue.push(ticket);
    this.queues.set(repo, queue);
    this.ensureHeadStaleTimer(repo);
    return { status: 'busy', holder, ticket };
  }

  /** Block until the ticket is promoted to holder, or until the wait times out. */
  waitFor(ticket: DevClaimTicket): Promise<WaitResult> {
    if (ticket.settled) return Promise.resolve(ticket.settled);
    return new Promise<WaitResult>((resolve) => {
      ticket.resolve = resolve;
      ticket.waitCancel = this.schedule(() => {
        if (ticket.settled) return;
        this.removeTicket(ticket, { status: 'timeout' });
      }, this.waitTimeoutMs);
    });
  }

  /** Release a repo held by this worker and hand off to the next waiter, if any. */
  release(repo: string, workerId: string): { released: boolean; promoted?: DevClaim } {
    if (!this.db.releaseDevClaim(repo, workerId)) return { released: false };
    return { released: true, promoted: this.promoteNext(repo) };
  }

  /** Break a claim regardless of holder (operator-initiated) and hand off. */
  forceRelease(repo: string): { prior?: DevClaim; promoted?: DevClaim } {
    const prior = this.db.forceReleaseDevClaim(repo);
    return { prior, promoted: this.promoteNext(repo) };
  }

  /** Teardown safety net: drop everything a worker holds (handing off) or is waiting for. */
  releaseAllFor(workerId: string): string[] {
    const removed = this.db.deleteDevClaimsByWorker(workerId);
    for (const c of removed) this.promoteNext(c.repoName);
    // Drop any queued tickets belonging to this worker.
    for (const queue of this.queues.values()) {
      for (const ticket of queue.filter((t) => t.workerId === workerId && !t.settled)) {
        this.removeTicket(ticket, { status: 'timeout' });
      }
    }
    return removed.map((c) => c.repoName);
  }

  /** Startup reconciliation: drop persisted claims whose holder is no longer an active worker. */
  reconcile(isActive: (workerId: string) => boolean): void {
    for (const c of this.db.listDevClaims()) {
      if (!isActive(c.workerId)) this.db.forceReleaseDevClaim(c.repoName);
    }
  }

  holderOf(repo: string): DevClaim | undefined { return this.db.getDevClaim(repo); }

  // --- internals ---

  private isStale(holder: DevClaim): boolean {
    return this.now() - holder.claimedAt >= this.ttlMs;
  }

  /** Promote the next queued waiter to holder. Returns the new holder, or undefined if none waited. */
  private promoteNext(repo: string, brokeStale?: DevClaim): DevClaim | undefined {
    const queue = this.queues.get(repo);
    if (!queue) return undefined;
    while (queue.length && queue[0].settled) queue.shift();
    const head = queue.shift();
    if (!head) { this.queues.delete(repo); return undefined; }

    this.db.forceSetDevClaim(repo, head.workerId, head.threadRootId, this.now());
    this.cancelTimers(head);
    head.settled = { status: 'granted', brokeStale };
    head.resolve?.(head.settled);
    this.ensureHeadStaleTimer(repo); // the next waiter (new head) waits on the new holder
    return this.db.getDevClaim(repo);
  }

  /** Ensure the current head-of-queue has a stale timer running against the current holder. */
  private ensureHeadStaleTimer(repo: string): void {
    const head = this.queues.get(repo)?.[0];
    if (!head || head.staleCancel || head.settled) return;
    const holder = this.db.getDevClaim(repo);
    if (!holder) return;
    const delay = Math.max(0, this.ttlMs - (this.now() - holder.claimedAt));
    head.staleCancel = this.schedule(() => this.onStaleTimer(repo, head), delay);
  }

  private onStaleTimer(repo: string, ticket: DevClaimTicket): void {
    ticket.staleCancel = undefined;
    if (ticket.settled || this.queues.get(repo)?.[0] !== ticket) return;
    const holder = this.db.getDevClaim(repo);
    if (!holder) { this.promoteNext(repo); return; }
    if (holder.workerId !== ticket.workerId && this.isStale(holder)) {
      const prior = this.db.forceReleaseDevClaim(repo);
      this.promoteNext(repo, prior);
    } else {
      // Not stale yet (clock skew) — re-arm for the remaining time.
      const delay = Math.max(0, this.ttlMs - (this.now() - holder.claimedAt));
      ticket.staleCancel = this.schedule(() => this.onStaleTimer(repo, ticket), delay);
    }
  }

  /** Remove an abandoned ticket (wait timeout / worker teardown) and re-arm the new head. */
  private removeTicket(ticket: DevClaimTicket, result: WaitResult): void {
    if (!ticket.settled) { ticket.settled = result; }
    this.cancelTimers(ticket);
    const queue = this.queues.get(ticket.repo);
    if (queue) {
      const i = queue.indexOf(ticket);
      if (i >= 0) queue.splice(i, 1);
      if (!queue.length) this.queues.delete(ticket.repo);
    }
    ticket.resolve?.(result);
    this.ensureHeadStaleTimer(ticket.repo);
  }

  private cancelTimers(ticket: DevClaimTicket): void {
    ticket.staleCancel?.(); ticket.staleCancel = undefined;
    ticket.waitCancel?.(); ticket.waitCancel = undefined;
  }
}
