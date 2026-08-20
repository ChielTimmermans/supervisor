import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { parseUsageLimit } from './usageLimit.js';
import { log } from './log.js';

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
  hooks?: Record<string, unknown>;
  // Resilience tuning + injectables (tests override wait/now to avoid real sleeps).
  wait?: (ms: number) => Promise<void>;
  now?: () => Date;
  retryFloorMs?: number;   // never wait less than this on a limit
  retryBackoffCapMs?: number; // cap for exponential backoff when no reset time is known
  retryMaxMs?: number;     // absolute ceiling for any single wait (bounds a bad reset value)
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
    private onPause?: (resetAt?: Date) => void,
    private onResume?: () => void,
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

  private buildOptions(): any {
    const options: any = {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      cwd: this.opts.cwd,
      model: this.opts.model,
      mcpServers: this.opts.mcpServers,
      allowedTools: this.opts.allowedTools,
      disallowedTools: this.opts.disallowedTools,
      env: this.opts.env,
      // Resume the live session if we have one (recover after a usage-limit pause),
      // otherwise fall back to the caller-provided resume id.
      resume: this._sessionId ?? this.opts.resume,
      hooks: this.opts.hooks,
    };
    if (this.opts.systemPromptAppend) {
      options.systemPrompt = { type: 'preset', preset: 'claude_code', append: this.opts.systemPromptAppend };
    }
    return options;
  }

  private now(): Date { return this.opts.now ? this.opts.now() : new Date(); }
  private wait(ms: number): Promise<void> {
    return this.opts.wait ? this.opts.wait(ms) : new Promise((r) => setTimeout(r, ms));
  }

  /** How long to wait before retrying a usage-limited session. */
  private retryDelay(resetAt: Date | null, attempt: number): number {
    const floor = this.opts.retryFloorMs ?? 1_000;
    const max = this.opts.retryMaxMs ?? 6 * 3_600_000; // 6h absolute ceiling
    if (resetAt) {
      const until = resetAt.getTime() - this.now().getTime() + 1_000; // small margin past the reset
      return Math.min(max, Math.max(floor, until));
    }
    const cap = this.opts.retryBackoffCapMs ?? 300_000; // 5 min
    return Math.min(cap, floor * 2 ** Math.max(0, attempt - 1));
  }

  private async runLoop(): Promise<void> {
    let attempt = 0;
    while (this.running) {
      const stream = this.queryFn({ prompt: this.queue, options: this.buildOptions() });
      try {
        for await (const msg of stream as AsyncIterable<any>) {
          if (msg?.session_id && !this._sessionId) {
            this._sessionId = msg.session_id;
            this.onSessionId?.(msg.session_id);
          }
          if (attempt > 0) { attempt = 0; this.onResume?.(); } // first message after a pause = recovered
        }
        return; // stream drained normally (queue closed) — nothing more to do
      } catch (err) {
        const limit = this.running ? parseUsageLimit(err, this.now()) : null;
        if (!limit) { this.running = false; this.onError?.(err); return; }
        attempt++;
        const delay = this.retryDelay(limit.resetAt, attempt);
        log.warn('session hit usage limit; pausing', {
          resetAt: limit.resetAt?.toISOString() ?? '(unknown)', delayMs: delay, attempt,
        });
        this.onPause?.(limit.resetAt ?? undefined);
        await this.wait(delay);
        // loop: re-establish the stream, resuming the same session id
      }
    }
  }
}
