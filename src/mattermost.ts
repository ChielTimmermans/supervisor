import { Client4, WebSocketClient, type WebSocketMessages } from '@mattermost/client';
import type { Post, PostList } from '@mattermost/types/posts';
import WebSocket from 'ws';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { log, preview } from './log.js';
import type { IncomingPost, ChannelCursor } from './types.js';
import type { Config } from './config.js';
import type { Db } from './db.js';

export function threadRootOf(post: { id: string; root_id: string }): string {
  return post.root_id || post.id;
}

interface RawAttachmentField { title?: string; value?: unknown }
interface RawAttachment { pretext?: string; title?: string; title_link?: string; text?: string; fields?: RawAttachmentField[] | null }

/**
 * Flatten Mattermost message attachments (`props.attachments[]`) to plain text.
 * Webhook integrations (e.g. GlitchTip) carry the real payload here while the
 * bare `message` is just a header, so the alert parsers need this content.
 */
export function flattenAttachments(props: unknown): string {
  const attachments = (props as { attachments?: RawAttachment[] } | null | undefined)?.attachments;
  if (!Array.isArray(attachments)) return '';
  const lines: string[] = [];
  for (const a of attachments) {
    for (const v of [a.pretext, a.title, a.title_link, a.text]) {
      if (typeof v === 'string' && v.trim()) lines.push(v.trim());
    }
    for (const f of a.fields ?? []) {
      const key = (f.title ?? '').trim();
      const val = f.value == null ? '' : String(f.value).trim();
      if (key || val) lines.push(key && val ? `${key}: ${val}` : key || val);
    }
  }
  return lines.join('\n');
}

export function normalizeIncomingPost(raw: Post, botUserId: string): IncomingPost {
  const attachmentText = flattenAttachments(raw.props);
  return {
    id: raw.id,
    channelId: raw.channel_id,
    rootId: raw.root_id || '',
    message: [raw.message, attachmentText].filter(Boolean).join('\n'),
    userId: raw.user_id,
    fileIds: raw.file_ids ?? [],
    isOwn: raw.user_id === botUserId,
  };
}

/**
 * The subset of `@mattermost/client`'s WebSocketClient we depend on. Declaring it
 * lets tests inject a fake socket to verify listener wiring without a real connection.
 */
export interface WsClientLike {
  addFirstConnectListener(cb: () => void): void;
  addReconnectListener(cb: () => void): void;
  addMissedMessageListener(cb: () => void): void;
  addCloseListener(cb: (connectFailCount: number) => void): void;
  addErrorListener(cb: (err: unknown) => void): void;
  addMessageListener(cb: (msg: { event: string; broadcast: { channel_id: string }; data: unknown }) => void): void;
  initialize(url: string, token: string): void;
  close(): void;
}

export interface Gateway {
  getBotId(): string;
  connect(onPost: (p: IncomingPost) => void): Promise<void>;
  post(args: { text: string; threadRootId?: string; fileIds?: string[] }): Promise<string>;
  uploadFile(filePath: string): Promise<string>;
  downloadFile(fileId: string, destPath: string): Promise<string>;
  addReaction(postId: string, emoji: string): Promise<void>;
  removeReaction(postId: string, emoji: string): Promise<void>;
  close(): void;
}

export class MattermostGateway implements Gateway {
  private client = new Client4();
  private ws?: WsClientLike;
  private botId = '';
  private inbound: Set<string>;
  /** In-memory fallback cursor store, used only when no `db` was supplied (e.g. some
   *  tests construct a gateway without one). Not durable across restarts. */
  private cursors = new Map<string, ChannelCursor>();
  /** Recently-dispatched post ids. Guards against a post reaching `onPost` twice when
   *  a live websocket delivery and a REST catch-up fetch race over the same post (e.g.
   *  a reconnect firing just after a post was already delivered live). Bounded so it
   *  can't grow without limit across a long-running process. */
  private seen = new Set<string>();
  private static readonly SEEN_LIMIT = 1000;

  constructor(
    private cfg: Config['mattermost'],
    ingestChannelIds: string[] = [],
    private createWsClient: () => WsClientLike = () =>
      new WebSocketClient({
        newWebSocketFn: (url: string) => new WebSocket(url) as unknown as globalThis.WebSocket,
      }) as unknown as WsClientLike,
    private db?: Db,
  ) {
    this.client.setUrl(cfg.url);
    this.client.setToken(cfg.token);
    // Inbound posts are accepted from the main channel plus every ingest channel.
    this.inbound = new Set([cfg.channelId, ...ingestChannelIds]);
  }

  getBotId(): string { return this.botId; }

  async connect(onPost: (p: IncomingPost) => void): Promise<void> {
    const me = await this.client.getMe();
    this.botId = me.id;
    log.info('mattermost connected', { bot: `${me.username}(${me.id})`, channels: [...this.inbound].join(',') });

    const ws = this.buildSocket(onPost);
    this.ws = ws;
    const wsUrl = this.cfg.url.replace(/^http/, 'ws') + '/api/v4/websocket';
    ws.initialize(wsUrl, this.cfg.token);
  }

  /** Wire all websocket listeners. Extracted so tests can drive them with a fake socket. */
  private buildSocket(onPost: (p: IncomingPost) => void): WsClientLike {
    const ws = this.createWsClient();
    ws.addFirstConnectListener(() => { log.info('websocket connected'); void this.catchUp(onPost); });
    ws.addReconnectListener(() => { log.warn('websocket reconnected'); void this.catchUp(onPost); });
    // CRITICAL: the Mattermost client only resets its event sequence number after a
    // reconnect if a missed-message listener is registered. Without one, a server
    // restart/timeout makes it loop forever on "missed websocket event" → close 4001
    // → reconnect with the same stale sequence — a permanent reconnect storm that
    // leaves the bot deaf. Registering this handler is what enables the reset path.
    // It's also our strongest signal that posts may have been missed, so it triggers
    // the same REST catch-up as first-connect/reconnect.
    ws.addMissedMessageListener(() => { log.warn('websocket resynced after missed events (server restart or timeout)'); void this.catchUp(onPost); });
    ws.addCloseListener((connectFailCount: number) => log.warn('websocket closed', { connectFailCount }));
    ws.addErrorListener((err: unknown) => log.error('websocket error', { err: err instanceof Error ? err.message : String(err) }));
    ws.addMessageListener((msg) => {
      if (msg.event !== 'posted') return;
      if (!this.inbound.has(msg.broadcast.channel_id)) return;
      const data = (msg as unknown as WebSocketMessages.Posted).data;
      const raw = JSON.parse(data.post) as Post;
      this.dispatchPost(raw, onPost);
    });
    return ws;
  }

  /** Normalize, dedupe, advance the per-channel cursor, and deliver one raw post to
   *  `onPost`. Shared by the live websocket path and REST catch-up so a post is handled
   *  identically — and only once — no matter which path saw it first. */
  private dispatchPost(raw: Post, onPost: (p: IncomingPost) => void): void {
    if (this.seen.has(raw.id)) return; // already handled via the other path (reconnect race)
    this.seen.add(raw.id);
    if (this.seen.size > MattermostGateway.SEEN_LIMIT) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    // Advance the durable cursor for every post we see — including the bot's own posts
    // and anything filtered below — so a restart never re-fetches history we've already
    // looked at, and the bot's own historical posts don't get stuck re-triggering catch-up.
    this.advanceCursor(raw);

    const p = normalizeIncomingPost(raw, this.botId);
    if (p.isOwn) return;
    log.info('◀ post received', { id: p.id, thread: p.rootId || '(root)', user: p.userId, files: p.fileIds.length, text: preview(p.message) });
    onPost(p);
  }

  private getCursor(channelId: string): ChannelCursor | undefined {
    return this.db ? this.db.getChannelCursor(channelId) : this.cursors.get(channelId);
  }

  private setCursor(channelId: string, cursor: ChannelCursor): void {
    if (this.db) this.db.setChannelCursor(channelId, cursor);
    else this.cursors.set(channelId, cursor);
  }

  private advanceCursor(raw: Post): void {
    const cur = this.getCursor(raw.channel_id);
    if (!cur || raw.create_at > cur.createAt || (raw.create_at === cur.createAt && raw.id !== cur.postId)) {
      this.setCursor(raw.channel_id, { postId: raw.id, createAt: raw.create_at });
    }
  }

  /** REST-based catch-up: fetch anything posted in each inbound channel since our last
   *  known cursor and replay it through the same path as a live post. Runs on first
   *  connect, on every reconnect, and when the client tells us it resynced after missed
   *  events — the points at which the websocket may have a gap behind it. */
  private async catchUp(onPost: (p: IncomingPost) => void): Promise<void> {
    for (const channelId of this.inbound) {
      try {
        await this.catchUpChannel(channelId, onPost);
      } catch (err) {
        log.warn('websocket catch-up failed', { channel: channelId, err: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private async catchUpChannel(channelId: string, onPost: (p: IncomingPost) => void): Promise<void> {
    const cursor = this.getCursor(channelId);
    if (!cursor) {
      // No durable marker yet (first-ever run for this channel, or a fresh db). There is
      // nothing to "catch up" on — baseline to now so we never backfill unbounded history.
      this.setCursor(channelId, { postId: '', createAt: Date.now() });
      return;
    }

    const list: PostList = await this.client.getPostsSince(channelId, cursor.createAt);
    const missed = list.order
      .map((id) => list.posts[id])
      .filter((raw): raw is Post => !!raw)
      .filter((raw) => raw.delete_at === 0) // don't resurface deleted posts
      .filter((raw) => raw.create_at > cursor.createAt || (raw.create_at === cursor.createAt && raw.id !== cursor.postId))
      .sort((a, b) => a.create_at - b.create_at);

    if (!missed.length) return;
    log.warn('websocket catch-up: replaying missed posts', { channel: channelId, count: missed.length });
    for (const raw of missed) this.dispatchPost(raw, onPost);
  }

  async post(args: { text: string; threadRootId?: string; fileIds?: string[] }): Promise<string> {
    log.debug('▶ post', { thread: args.threadRootId || '(root)', files: args.fileIds?.length ?? 0, text: preview(args.text) });
    const created = await this.client.createPost({
      channel_id: this.cfg.channelId,
      message: args.text,
      root_id: args.threadRootId ?? '',
      file_ids: args.fileIds,
    });
    return created.id;
  }

  async uploadFile(filePath: string): Promise<string> {
    const bytes = await readFile(filePath);
    const form = new FormData();
    form.append('channel_id', this.cfg.channelId);
    form.append('files', new Blob([bytes]), basename(filePath));
    const res = await this.client.uploadFile(form);
    return res.file_infos[0].id;
  }

  async addReaction(postId: string, emoji: string): Promise<void> {
    await this.client.addReaction(this.botId, postId, emoji);
  }

  async removeReaction(postId: string, emoji: string): Promise<void> {
    await this.client.removeReaction(this.botId, postId, emoji);
  }

  async downloadFile(fileId: string, destPath: string): Promise<string> {
    // getFileRoute already returns an absolute URL (base + /api/v4/files/<id>);
    // prefixing getUrl() again produced a doubled host ("...comhttps://...") and a crash.
    const url = this.client.getFileRoute(fileId);
    const resp = await fetch(url, { headers: { Authorization: `BEARER ${this.client.getToken()}` } });
    const bytes = Buffer.from(await resp.arrayBuffer());
    await writeFile(destPath, bytes);
    return destPath;
  }

  close(): void { this.ws?.close(); }
}
