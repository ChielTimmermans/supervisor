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

describe('MattermostGateway websocket wiring', () => {
  function fakeWs() {
    return {
      firstConnect: [] as Array<() => void>,
      reconnect: [] as Array<() => void>,
      missed: [] as Array<() => void>,
      closeCbs: [] as Array<(c: number) => void>,
      error: [] as Array<(e: unknown) => void>,
      message: [] as Array<(m: any) => void>,
      initialized: null as null | { url: string; token: string },
      addFirstConnectListener(cb: () => void) { this.firstConnect.push(cb); },
      addReconnectListener(cb: () => void) { this.reconnect.push(cb); },
      addMissedMessageListener(cb: () => void) { this.missed.push(cb); },
      addCloseListener(cb: (c: number) => void) { this.closeCbs.push(cb); },
      addErrorListener(cb: (e: unknown) => void) { this.error.push(cb); },
      addMessageListener(cb: (m: any) => void) { this.message.push(cb); },
      initialize(url: string, token: string) { this.initialized = { url, token }; },
      close() { /* noop */ },
    };
  }

  it('registers a missed-message listener so the client resets its sequence after a server restart (prevents the 4001 reconnect storm)', () => {
    const ws = fakeWs();
    const gw = new MattermostGateway(
      { url: 'https://chat.example.com', token: 't', channelId: 'c' },
      [],
      () => ws as any,
    );
    (gw as any).buildSocket(() => {});
    // Without any missed-message listener the Mattermost client never resets its
    // sequence number after a reconnect and loops forever on "missed websocket event".
    expect(ws.missed.length).toBe(1);
  });

  it('only delivers "posted" events from inbound channels, skipping the bot\'s own posts', () => {
    const ws = fakeWs();
    const gw = new MattermostGateway(
      { url: 'https://chat.example.com', token: 't', channelId: 'main' },
      ['ingest'],
      () => ws as any,
    );
    (gw as any).botId = 'bot';
    const received: string[] = [];
    (gw as any).buildSocket((p: { id: string }) => received.push(p.id));
    const handler = ws.message[0];
    const posted = (channel: string, post: object) => ({
      event: 'posted', broadcast: { channel_id: channel }, data: { post: JSON.stringify(post) },
    });
    handler(posted('main', { id: 'p1', channel_id: 'main', user_id: 'u1' }));
    handler(posted('other', { id: 'p2', channel_id: 'other', user_id: 'u1' })); // not inbound
    handler(posted('ingest', { id: 'p3', channel_id: 'ingest', user_id: 'u2' }));
    handler(posted('main', { id: 'p4', channel_id: 'main', user_id: 'bot' })); // own post
    expect(received).toEqual(['p1', 'p3']);
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
