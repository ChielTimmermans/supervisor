import { Client4, WebSocketClient, type WebSocketMessages } from '@mattermost/client';
import type { Post } from '@mattermost/types/posts';
import WebSocket from 'ws';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { log, preview } from './log.js';
import type { IncomingPost } from './types.js';
import type { Config } from './config.js';

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
  private ws?: WebSocketClient;
  private botId = '';
  private inbound: Set<string>;

  constructor(private cfg: Config['mattermost'], ingestChannelIds: string[] = []) {
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

    const ws = new WebSocketClient({
      newWebSocketFn: (url: string) => new WebSocket(url) as unknown as globalThis.WebSocket,
    });
    this.ws = ws;
    ws.addFirstConnectListener(() => log.info('websocket connected'));
    ws.addReconnectListener(() => log.warn('websocket reconnected'));
    ws.addCloseListener((code: number) => log.warn('websocket closed', { code }));
    ws.addErrorListener((err: unknown) => log.error('websocket error', { err: err instanceof Error ? err.message : String(err) }));
    ws.addMessageListener((msg) => {
      if (msg.event !== 'posted') return;
      if (!this.inbound.has(msg.broadcast.channel_id)) return;
      const data = (msg as WebSocketMessages.Posted).data;
      const raw = JSON.parse(data.post) as Post;
      const p = normalizeIncomingPost(raw, this.botId);
      if (p.isOwn) return;
      log.info('◀ post received', { id: p.id, thread: p.rootId || '(root)', user: p.userId, files: p.fileIds.length, text: preview(p.message) });
      onPost(p);
    });
    const wsUrl = this.cfg.url.replace(/^http/, 'ws') + '/api/v4/websocket';
    ws.initialize(wsUrl, this.cfg.token);
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
    const url = this.client.getUrl() + this.client.getFileRoute(fileId);
    const resp = await fetch(url, { headers: { Authorization: `BEARER ${this.client.getToken()}` } });
    const bytes = Buffer.from(await resp.arrayBuffer());
    await writeFile(destPath, bytes);
    return destPath;
  }

  close(): void { this.ws?.close(); }
}
