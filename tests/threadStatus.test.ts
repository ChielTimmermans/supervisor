import { describe, it, expect } from 'vitest';
import { STATUS_EMOJI, applyThreadStatus, type Reactor, type ThreadState } from '../src/threadStatus.js';

function fakeReactor(): Reactor & { added: [string, string][]; removed: [string, string][] } {
  const added: [string, string][] = [];
  const removed: [string, string][] = [];
  return {
    added, removed,
    addReaction: async (postId, emoji) => { added.push([postId, emoji]); },
    removeReaction: async (postId, emoji) => { removed.push([postId, emoji]); },
  };
}

describe('STATUS_EMOJI', () => {
  it('maps each state to the agreed emoji', () => {
    expect(STATUS_EMOJI).toEqual({
      queued: 'clock3',
      running: 'hourglass_flowing_sand',
      waiting: 'raised_hand',
      proposed: 'checkered_flag',
      done: 'white_check_mark',
      failed: 'x',
    });
  });
});

describe('applyThreadStatus', () => {
  it('adds the target emoji to the thread root post', async () => {
    const r = fakeReactor();
    await applyThreadStatus(r, 'root-1', 'done');
    expect(r.added).toContainEqual(['root-1', 'white_check_mark']);
  });

  it('removes the other four status emojis so only one chip shows', async () => {
    const r = fakeReactor();
    await applyThreadStatus(r, 'root-1', 'running');
    const others = (Object.keys(STATUS_EMOJI) as ThreadState[])
      .filter((s) => s !== 'running')
      .map((s) => STATUS_EMOJI[s]);
    for (const emoji of others) expect(r.removed).toContainEqual(['root-1', emoji]);
    expect(r.removed).not.toContainEqual(['root-1', STATUS_EMOJI.running]);
  });

  it('does not throw when a reaction removal fails (reaction absent)', async () => {
    const r: Reactor = {
      addReaction: async () => {},
      removeReaction: async () => { throw new Error('reaction not found'); },
    };
    await expect(applyThreadStatus(r, 'root-1', 'failed')).resolves.toBeUndefined();
  });
});
