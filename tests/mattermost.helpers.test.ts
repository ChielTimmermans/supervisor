import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import { normalizeIncomingPost, threadRootOf, MattermostGateway } from '../src/mattermost.js';
import { Db } from '../src/db.js';

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

describe('MattermostGateway websocket catch-up', () => {
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

  type RawPostFixture = { id: string; create_at: number; user_id?: string; channel_id?: string; root_id?: string; message?: string; delete_at?: number };

  function postListOf(posts: RawPostFixture[]): any {
    const full = posts.map((p) => ({ channel_id: 'main', user_id: 'u1', root_id: '', message: 'm', delete_at: 0, ...p }));
    return {
      order: full.map((p) => p.id),
      posts: Object.fromEntries(full.map((p) => [p.id, p])),
      next_post_id: '', prev_post_id: '', first_inaccessible_post_time: 0,
    };
  }

  it('on first-ever connect with no persisted cursor, baselines to now without fetching (bounded — no unbounded backfill)', async () => {
    const ws = fakeWs();
    const db = new Db(':memory:');
    const gw = new MattermostGateway({ url: 'https://chat.example.com', token: 't', channelId: 'main' }, [], () => ws as any, db);
    const spy = vi.spyOn((gw as any).client, 'getPostsSince');
    const received: string[] = [];
    (gw as any).buildSocket((p: { id: string }) => received.push(p.id));

    ws.firstConnect[0]();
    await vi.waitFor(() => expect(db.getChannelCursor('main')).toBeTruthy());

    expect(spy).not.toHaveBeenCalled();
    expect(received).toEqual([]);
  });

  it('on reconnect, fetches and processes posts missed while disconnected', async () => {
    const ws = fakeWs();
    const db = new Db(':memory:');
    db.setChannelCursor('main', { postId: 'p0', createAt: 1000 }); // as if p0 was processed before the drop
    const gw = new MattermostGateway({ url: 'https://chat.example.com', token: 't', channelId: 'main' }, [], () => ws as any, db);
    (gw as any).botId = 'bot';
    vi.spyOn((gw as any).client, 'getPostsSince').mockResolvedValue(postListOf([
      { id: 'p1', create_at: 1100, user_id: 'u1' },
      { id: 'p2', create_at: 1200, user_id: 'u1' },
    ]));
    const received: string[] = [];
    (gw as any).buildSocket((p: { id: string }) => received.push(p.id));

    ws.reconnect[0]();
    await vi.waitFor(() => expect(received).toEqual(['p1', 'p2']));
    expect(db.getChannelCursor('main')).toEqual({ postId: 'p2', createAt: 1200 });
  });

  it('does not replay already-processed posts on a normal clean reconnect', async () => {
    const ws = fakeWs();
    const db = new Db(':memory:');
    db.setChannelCursor('main', { postId: 'p2', createAt: 1200 });
    const gw = new MattermostGateway({ url: 'https://chat.example.com', token: 't', channelId: 'main' }, [], () => ws as any, db);
    (gw as any).botId = 'bot';
    const spy = vi.spyOn((gw as any).client, 'getPostsSince').mockResolvedValue(postListOf([])); // nothing new server-side
    const received: string[] = [];
    (gw as any).buildSocket((p: { id: string }) => received.push(p.id));

    ws.reconnect[0]();
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(received).toEqual([]);
    expect(db.getChannelCursor('main')).toEqual({ postId: 'p2', createAt: 1200 }); // unchanged
  });

  it('a post delivered live and then re-seen via an overlapping catch-up is only processed once', async () => {
    const ws = fakeWs();
    const db = new Db(':memory:');
    db.setChannelCursor('main', { postId: 'p0', createAt: 1000 });
    const gw = new MattermostGateway({ url: 'https://chat.example.com', token: 't', channelId: 'main' }, [], () => ws as any, db);
    (gw as any).botId = 'bot';
    const received: string[] = [];
    (gw as any).buildSocket((p: { id: string }) => received.push(p.id));
    const handler = ws.message[0];

    // Live delivery of p1 via the websocket.
    handler({
      event: 'posted', broadcast: { channel_id: 'main' },
      data: { post: JSON.stringify({ id: 'p1', channel_id: 'main', user_id: 'u1', root_id: '', message: 'm', create_at: 1100, delete_at: 0 }) },
    });

    // A reconnect fires moments later and its catch-up also returns p1 (race).
    const spy = vi.spyOn((gw as any).client, 'getPostsSince').mockResolvedValue(postListOf([{ id: 'p1', create_at: 1100, user_id: 'u1' }]));
    ws.reconnect[0]();
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());

    expect(received).toEqual(['p1']); // not delivered twice
  });

  it("does not reprocess the bot's own historical posts, but still advances the cursor past them", async () => {
    const ws = fakeWs();
    const db = new Db(':memory:');
    db.setChannelCursor('main', { postId: 'p0', createAt: 1000 });
    const gw = new MattermostGateway({ url: 'https://chat.example.com', token: 't', channelId: 'main' }, [], () => ws as any, db);
    (gw as any).botId = 'bot';
    vi.spyOn((gw as any).client, 'getPostsSince').mockResolvedValue(postListOf([{ id: 'p1', create_at: 1100, user_id: 'bot' }]));
    const received: string[] = [];
    (gw as any).buildSocket((p: { id: string }) => received.push(p.id));

    ws.reconnect[0]();
    await vi.waitFor(() => expect(db.getChannelCursor('main')).toEqual({ postId: 'p1', createAt: 1100 }));
    expect(received).toEqual([]); // own post filtered, per existing isOwn behavior
  });
});
