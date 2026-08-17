import { log } from './log.js';

// Visual status of a worker thread, shown as a single emoji reaction on the
// thread's root post so running vs. done threads are scannable at a glance.
export type ThreadState = 'running' | 'waiting' | 'proposed' | 'done' | 'failed';

export const STATUS_EMOJI: Record<ThreadState, string> = {
  running: 'hourglass_flowing_sand', // ⏳ worker actively working
  waiting: 'raised_hand',            // ✋ waiting on the operator
  proposed: 'checkered_flag',        // 🏁 finish proposed, awaiting /done
  done: 'white_check_mark',          // ✅ operator closed the thread
  failed: 'x',                       // ❌ session crashed / could not resume
};

/** Minimal reaction surface `applyThreadStatus` depends on (implemented by the Gateway). */
export interface Reactor {
  addReaction(postId: string, emoji: string): Promise<void>;
  removeReaction(postId: string, emoji: string): Promise<void>;
}

/**
 * Set the thread's status chip to `state`: remove the other status emojis
 * (a reaction that isn't present is a harmless no-op) and add the target one.
 * Stateless by design so it survives restarts without tracking prior reactions.
 */
export async function applyThreadStatus(reactor: Reactor, threadRootId: string, state: ThreadState): Promise<void> {
  const target = STATUS_EMOJI[state];
  for (const s of Object.keys(STATUS_EMOJI) as ThreadState[]) {
    if (STATUS_EMOJI[s] === target) continue;
    try {
      await reactor.removeReaction(threadRootId, STATUS_EMOJI[s]);
    } catch (err) {
      log.debug('removeReaction skipped', { thread: threadRootId, emoji: STATUS_EMOJI[s], err: err instanceof Error ? err.message : String(err) });
    }
  }
  try {
    await reactor.addReaction(threadRootId, target);
  } catch (err) {
    log.warn('addReaction failed', { thread: threadRootId, emoji: target, err: err instanceof Error ? err.message : String(err) });
  }
}
