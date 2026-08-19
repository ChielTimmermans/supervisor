import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import { normalizeIncomingPost, threadRootOf, MattermostGateway } from '../src/mattermost.js';

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

  it('normalizeIncomingPost folds webhook attachments (title/text/fields) into the message', () => {
    const raw = {
      id: 'p3', channel_id: 'c1', root_id: '', user_id: 'u1',
      message: 'GlitchTip Alert (2 issues)',
      props: {
        attachments: [{
          title: 'TypeError: Failed to fetch dynamically imported module: https://console.thechipmakers.dev/chunk-V4Jabc123.js',
          title_link: 'https://console.thechipmakers.dev/issues/1',
          fields: [
            { title: 'Project', value: 'console-frontend' },
            { title: 'Environment', value: 'development' },
          ],
        }],
      },
    };
    const p = normalizeIncomingPost(raw as any, 'bot');
    expect(p.message).toContain('GlitchTip Alert');
    expect(p.message).toContain('Failed to fetch dynamically imported module');
    expect(p.message).toContain('console-frontend');
    expect(p.message).toContain('development');
  });
});

describe('MattermostGateway.downloadFile', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fetches the absolute file route without doubling the base URL', async () => {
    const gw = new MattermostGateway({ url: 'https://chat.example.com', token: 't', channelId: 'c' });
    let fetchedUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      fetchedUrl = String(url);
      return { arrayBuffer: async () => new TextEncoder().encode('abc').buffer } as unknown as Response;
    }));
    const dest = path.join('scratch', 'dl-url-test.bin');

    await gw.downloadFile('fid123', dest);

    expect(fetchedUrl).toBe('https://chat.example.com/api/v4/files/fid123');
    expect(fetchedUrl).not.toContain('.comhttps');
  });
});
