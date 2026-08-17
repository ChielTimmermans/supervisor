import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { log, preview } from '../log.js';
import { applyThreadStatus } from '../threadStatus.js';
import type { Gateway } from '../mattermost.js';
import type { Db } from '../db.js';
import type { PendingQuestions } from '../pending.js';

export interface WorkerToolDeps {
  gateway: Gateway;
  db: Db;
  pending: PendingQuestions;
  workerId: string;
  threadRootId: string;
}

type ToolResult = { content: { type: 'text'; text: string }[] };
const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });

export async function askUserHandler(deps: WorkerToolDeps, args: { question: string }): Promise<ToolResult> {
  const postId = await deps.gateway.post({ text: args.question, threadRootId: deps.threadRootId });
  deps.db.updateWorker(deps.workerId, { status: 'waiting' });
  // Fire-and-forget: reacting must not delay arming pending.ask, or a fast reply would race in unresolved.
  void applyThreadStatus(deps.gateway, deps.threadRootId, 'waiting');
  log.info('worker asks — waiting for reply', { worker: deps.workerId, q: preview(args.question) });
  const answer = await deps.pending.ask({ workerId: deps.workerId, questionPostId: postId });
  deps.db.updateWorker(deps.workerId, { status: 'running' });
  void applyThreadStatus(deps.gateway, deps.threadRootId, 'running');
  log.info('worker got reply — resuming', { worker: deps.workerId });
  return text(`The operator replied: ${answer}`);
}

export async function sendUpdateHandler(deps: WorkerToolDeps, args: { text: string; files?: string[] }): Promise<ToolResult> {
  const fileIds: string[] = [];
  for (const f of args.files ?? []) fileIds.push(await deps.gateway.uploadFile(f));
  await deps.gateway.post({ text: args.text, threadRootId: deps.threadRootId, fileIds: fileIds.length ? fileIds : undefined });
  log.info('worker update', { worker: deps.workerId, files: fileIds.length, text: preview(args.text) });
  return text('Update posted to the operator.');
}

export async function finishHandler(deps: WorkerToolDeps, args: { summary: string }): Promise<ToolResult> {
  await deps.gateway.post({
    text: `✅ I believe this feature is complete:\n\n${args.summary}\n\n_Reply with any changes to keep going, or type \`/done\` to close this thread._`,
    threadRootId: deps.threadRootId,
  });
  void applyThreadStatus(deps.gateway, deps.threadRootId, 'proposed');
  log.info('worker proposed completion', { worker: deps.workerId });
  return text('Completion proposed to the operator. Do NOT end the feature yourself — the operator decides. Wait for their reply: they will either request more changes (address them, then call finish again) or close the thread with /done.');
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
      tool('finish', 'Propose that this feature is complete and post a summary for the operator to review. This does NOT end the work — the operator decides. They will either reply with more changes (keep going, call finish again when done) or close the thread themselves with /done.',
        { summary: z.string() },
        (a) => finishHandler(deps, a) as Promise<CallToolResult>),
    ],
  });
  return { server, toolNames: ['mcp__worker__ask_user', 'mcp__worker__send_update', 'mcp__worker__finish'] };
}
