import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Gateway } from '../mattermost.js';
import type { Db } from '../db.js';
import type { PendingQuestions } from '../pending.js';

export interface WorkerToolDeps {
  gateway: Gateway;
  db: Db;
  pending: PendingQuestions;
  workerId: string;
  threadRootId: string;
  onFinish: () => void;
}

type ToolResult = { content: { type: 'text'; text: string }[] };
const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });

export async function askUserHandler(deps: WorkerToolDeps, args: { question: string }): Promise<ToolResult> {
  const postId = await deps.gateway.post({ text: args.question, threadRootId: deps.threadRootId });
  deps.db.updateWorker(deps.workerId, { status: 'waiting' });
  const answer = await deps.pending.ask({ workerId: deps.workerId, questionPostId: postId });
  deps.db.updateWorker(deps.workerId, { status: 'running' });
  return text(`The operator replied: ${answer}`);
}

export async function sendUpdateHandler(deps: WorkerToolDeps, args: { text: string; files?: string[] }): Promise<ToolResult> {
  const fileIds: string[] = [];
  for (const f of args.files ?? []) fileIds.push(await deps.gateway.uploadFile(f));
  await deps.gateway.post({ text: args.text, threadRootId: deps.threadRootId, fileIds: fileIds.length ? fileIds : undefined });
  return text('Update posted to the operator.');
}

export async function finishHandler(deps: WorkerToolDeps, args: { summary: string }): Promise<ToolResult> {
  await deps.gateway.post({ text: args.summary, threadRootId: deps.threadRootId });
  deps.db.updateWorker(deps.workerId, { status: 'finished' });
  deps.onFinish();
  return text('Marked finished.');
}

export function createWorkerToolServer(deps: WorkerToolDeps): { server: unknown; toolNames: string[] } {
  const server = createSdkMcpServer({
    name: 'worker',
    version: '1.0.0',
    tools: [
      tool('ask_user', 'Ask the human operator a question in this feature\'s thread and wait for their reply. Use whenever you need input, a decision, or clarification.',
        { question: z.string().describe('The question to ask the operator') },
        (a) => askUserHandler(deps, a) as Promise<CallToolResult>),
      tool('send_update', 'Post a progress update to the operator, optionally attaching files (specs, plans, diffs). Use to share artifacts or status.',
        { text: z.string(), files: z.array(z.string()).optional().describe('Absolute file paths to attach') },
        (a) => sendUpdateHandler(deps, a) as Promise<CallToolResult>),
      tool('finish', 'Post a final summary and mark this feature complete.',
        { summary: z.string() },
        (a) => finishHandler(deps, a) as Promise<CallToolResult>),
    ],
  });
  return { server, toolNames: ['mcp__worker__ask_user', 'mcp__worker__send_update', 'mcp__worker__finish'] };
}
