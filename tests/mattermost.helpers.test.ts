import { describe, it, expect } from 'vitest';
import { normalizeIncomingPost, threadRootOf } from '../src/mattermost.js';

describe('mattermost helpers', () => {
  it('threadRootOf returns root_id when present, else id', () => {
    expect(threadRootOf({ id: 'p1', root_id: '' })).toBe('p1');
    expect(threadRootOf({ id: 'p2', root_id: 'r1' })).toBe('r1');
  });

  it('normalizeIncomingPost maps fields and flags own posts', () => {
    const raw = { id: 'p1', channel_id: 'c1', root_id: '', message: 'hi', user_id: 'bot', file_ids: ['f1'] };
    const p = normalizeIncomingPost(raw as any, 'bot');
    expect(p).toEqual({ id: 'p1', channelId: 'c1', rootId: '', message: 'hi', userId: 'bot', fileIds: ['f1'], isOwn: true });
  });

  it('normalizeIncomingPost defaults missing file_ids to []', () => {
    const raw = { id: 'p2', channel_id: 'c1', root_id: 'r1', message: 'yo', user_id: 'u1' };
    const p = normalizeIncomingPost(raw as any, 'bot');
    expect(p.fileIds).toEqual([]);
    expect(p.isOwn).toBe(false);
  });
});
