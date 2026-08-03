import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export type QueryFn = typeof import('@anthropic-ai/claude-agent-sdk').query;

export interface SessionOptions {
  cwd?: string;
  systemPromptAppend?: string;
  model?: string;
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  disallowedTools?: string[];
  env?: Record<string, string>;
  resume?: string;
}

// Minimal async queue: an async-iterable you can push to and close.
class MessageQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private resolvers: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;
  push(item: T): void {
    if (this.closed) return;
    const r = this.resolvers.shift();
    if (r) r({ value: item, done: false });
    else this.items.push(item);
  }
  close(): void {
    this.closed = true;
    let r; while ((r = this.resolvers.shift())) r({ value: undefined as any, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as any, done: true });
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

// Construct a minimal SDKUserMessage for a plain-text user turn.
// parent_tool_use_id is required by SDKUserMessage (null for top-level messages).
function userMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

export class ClaudeSession {
  private queue = new MessageQueue<SDKUserMessage>();
  private _sessionId?: string;
  private running = false;
  constructor(
    private queryFn: QueryFn,
    private opts: SessionOptions,
    private onSessionId?: (id: string) => void,
    private onError?: (err: unknown) => void,
  ) {}

  get sessionId(): string | undefined { return this._sessionId; }

  start(initialMessage: string): void {
    if (this.running) return;
    this.running = true;
    this.queue.push(userMessage(initialMessage));
    void this.runLoop();
  }

  push(text: string): void { this.queue.push(userMessage(text)); }
  stop(): void { this.queue.close(); this.running = false; }

  private async runLoop(): Promise<void> {
    const options: any = {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      cwd: this.opts.cwd,
      model: this.opts.model,
      mcpServers: this.opts.mcpServers,
      allowedTools: this.opts.allowedTools,
      disallowedTools: this.opts.disallowedTools,
      env: this.opts.env,
      resume: this.opts.resume,
    };
    if (this.opts.systemPromptAppend) {
      options.systemPrompt = { type: 'preset', preset: 'claude_code', append: this.opts.systemPromptAppend };
    }
    const stream = this.queryFn({ prompt: this.queue, options });
    try {
      for await (const msg of stream as AsyncIterable<any>) {
        if (msg?.session_id && !this._sessionId) {
          this._sessionId = msg.session_id;
          this.onSessionId?.(msg.session_id);
        }
      }
    } catch (err) {
      this.running = false;
      this.onError?.(err);
    }
  }
}
