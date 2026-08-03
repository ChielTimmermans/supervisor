import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Gateway } from '../mattermost.js';
import type { Db } from '../db.js';
import type { Config } from '../config.js';

export interface SupervisorToolDeps {
  gateway: Gateway;
  db: Db;
  cfg: Config;
  spawnWorker(args: { repo: string; task: string; threadRootId: string }): { ok: true; workerId: string } | { ok: false; reason: string };
  stopWorker(workerId: string): void;
}

type ToolResult = { content: { type: 'text'; text: string }[] };
const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });

export async function listReposHandler(deps: SupervisorToolDeps, _args: {}): Promise<ToolResult> {
  const lines = Object.entries(deps.cfg.repos).map(([name, r]) => `- ${name}: ${r.description} (${r.path})`);
  return text(`Available repositories:\n${lines.join('\n')}`);
}

export async function spawnWorkerHandler(deps: SupervisorToolDeps, args: { repo: string; task: string; threadRootId: string }): Promise<ToolResult> {
  if (!deps.cfg.repos[args.repo]) {
    return text(`Unknown repo "${args.repo}". Known repos: ${Object.keys(deps.cfg.repos).join(', ')}. Ask the operator which one to use.`);
  }
  const r = deps.spawnWorker(args);
  return r.ok ? text(`Spawned worker ${r.workerId} in ${args.repo}.`) : text(`Could not spawn worker: ${r.reason}`);
}

export async function listWorkersHandler(deps: SupervisorToolDeps, _args: {}): Promise<ToolResult> {
  const workers = deps.db.listWorkers();
  if (!workers.length) return text('No workers.');
  const lines = workers.map((w) => `- ${w.id} [${w.status}] repo=${w.repoName} thread=${w.threadRootId} task="${w.task}"`);
  return text(lines.join('\n'));
}

export async function postToChannelHandler(deps: SupervisorToolDeps, args: { text: string; threadRootId?: string }): Promise<ToolResult> {
  await deps.gateway.post({ text: args.text, threadRootId: args.threadRootId });
  return text('Posted.');
}

export async function stopWorkerHandler(deps: SupervisorToolDeps, args: { workerId: string }): Promise<ToolResult> {
  deps.stopWorker(args.workerId);
  return text(`Stopped worker ${args.workerId}.`);
}

export function createSupervisorToolServer(deps: SupervisorToolDeps): { server: unknown; toolNames: string[] } {
  const server = createSdkMcpServer({
    name: 'supervisor',
    version: '1.0.0',
    tools: [
      tool('list_repos', 'List the repositories you can spawn workers in.', {}, (a) => listReposHandler(deps, a) as Promise<CallToolResult>),
      tool('spawn_worker', 'Start a worker on a feature in a repository. Provide the repo registry name, the task, and the thread root id you were given.',
        { repo: z.string(), task: z.string(), threadRootId: z.string() }, (a) => spawnWorkerHandler(deps, a) as Promise<CallToolResult>),
      tool('list_workers', 'List current workers and their status.', {}, (a) => listWorkersHandler(deps, a) as Promise<CallToolResult>),
      tool('post_to_channel', 'Post a message to the operator (channel-level, or into a thread if threadRootId is given).',
        { text: z.string(), threadRootId: z.string().optional() }, (a) => postToChannelHandler(deps, a) as Promise<CallToolResult>),
      tool('stop_worker', 'Terminate a worker.', { workerId: z.string() }, (a) => stopWorkerHandler(deps, a) as Promise<CallToolResult>),
    ],
  });
  return {
    server,
    toolNames: ['mcp__supervisor__list_repos', 'mcp__supervisor__spawn_worker', 'mcp__supervisor__list_workers', 'mcp__supervisor__post_to_channel', 'mcp__supervisor__stop_worker'],
  };
}
