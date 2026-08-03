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

export function normalizeIncomingPost(raw: Post, botUserId: string): IncomingPost {
  return {
    id: raw.id,
    channelId: raw.channel_id,
    rootId: raw.root_id || '',
    message: raw.message,
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
  close(): void;
}

export class MattermostGateway implements Gateway {
  private client = new Client4();
  private ws?: WebSocketClient;
  private botId = '';

  constructor(private cfg: Config['mattermost']) {
    this.client.setUrl(cfg.url);
    this.client.setToken(cfg.token);
  }

  getBotId(): string { return this.botId; }

  async connect(onPost: (p: IncomingPost) => void): Promise<void> {
    const me = await this.client.getMe();
    this.botId = me.id;
    log.info('mattermost connected', { bot: `${me.username}(${me.id})`, channel: this.cfg.channelId });

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
      if (msg.broadcast.channel_id !== this.cfg.channelId) return;
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

  async downloadFile(fileId: string, destPath: string): Promise<string> {
    const url = this.client.getUrl() + this.client.getFileRoute(fileId);
    const resp = await fetch(url, { headers: { Authorization: `BEARER ${this.client.getToken()}` } });
    const bytes = Buffer.from(await resp.arrayBuffer());
    await writeFile(destPath, bytes);
    return destPath;
  }

  close(): void { this.ws?.close(); }
}
