import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { log, preview } from '../log.js';
import { applyThreadStatus } from '../threadStatus.js';
import type { Gateway } from '../mattermost.js';
import type { Db } from '../db.js';
import type { PendingQuestions } from '../pending.js';
import type { DevEnvLocks } from '../devEnvLocks.js';
import type { DevClaim, WorkerKind } from '../types.js';

export interface WorkerToolDeps {
  gateway: Gateway;
  db: Db;
  pending: PendingQuestions;
  workerId: string;
  threadRootId: string;
  repoName: string;
  kind: WorkerKind;
  devLocks: DevEnvLocks;
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

/** Tell the (stale/stuck) prior holder, in its own thread, that its dev-env claim was broken. */
async function notifyBrokeStale(deps: WorkerToolDeps, prior: DevClaim): Promise<void> {
  await deps.gateway.post({
    text: `⚠️ Your hold on the **${prior.repoName}** dev environment was released after being held past the limit (you may be stuck). Another worker has taken it. Re-claim with claim_dev if you still need it.`,
    threadRootId: prior.threadRootId,
  });
}

export async function claimDevHandler(deps: WorkerToolDeps, _args: {}): Promise<ToolResult> {
  const { devLocks, repoName, workerId, threadRootId, gateway } = deps;
  const res = devLocks.claim(repoName, workerId, threadRootId);

  if (res.status === 'granted') {
    log.info('claimed dev env', { worker: workerId, repo: repoName });
    return text(`You now hold the ${repoName} dev environment. Call release_dev as soon as you're done so other workers can use it.`);
  }
  if (res.status === 'granted-broke-stale') {
    log.warn('claimed dev env by breaking a stale hold', { worker: workerId, repo: repoName, prior: res.prior.workerId });
    await notifyBrokeStale(deps, res.prior);
    return text(`You now hold the ${repoName} dev environment (a stale/stuck worker's hold was broken to grant it). Call release_dev when done.`);
  }

  // Busy: tell the operator we're waiting, then block until promoted or we give up.
  log.info('dev env busy — waiting', { worker: workerId, repo: repoName, heldBy: res.holder.workerId });
  await gateway.post({ text: `⏳ Waiting for the **${repoName}** dev environment — another worker is using it. I'll continue automatically as soon as it frees.`, threadRootId });
  deps.db.updateWorker(workerId, { status: 'waiting' });
  void applyThreadStatus(gateway, threadRootId, 'waiting');

  const wr = await devLocks.waitFor(res.ticket);

  deps.db.updateWorker(workerId, { status: 'running' });
  void applyThreadStatus(gateway, threadRootId, 'running');

  if (wr.status === 'granted') {
    log.info('dev env acquired after waiting', { worker: workerId, repo: repoName });
    if (wr.brokeStale) await notifyBrokeStale(deps, wr.brokeStale);
    await gateway.post({ text: `▶️ The **${repoName}** dev environment is free — you now hold it.`, threadRootId });
    return text(`The ${repoName} dev environment is now yours. Call release_dev when done.`);
  }

  log.warn('gave up waiting for dev env', { worker: workerId, repo: repoName });
  await gateway.post({ text: `⌛ Still waiting for the **${repoName}** dev environment — the current holder may be stuck. The operator can free it with \`/release\` in the holder's thread.`, threadRootId });
  return text(`The ${repoName} dev environment is still busy and you do NOT hold it. Do other work that doesn't need it, or ask the operator to free it. You can call claim_dev again later.`);
}

export async function releaseDevHandler(deps: WorkerToolDeps, _args: {}): Promise<ToolResult> {
  const res = deps.devLocks.release(deps.repoName, deps.workerId);
  if (!res.released) return text(`You don't currently hold the ${deps.repoName} dev environment, so there's nothing to release.`);
  log.info('released dev env', { worker: deps.workerId, repo: deps.repoName, handedOff: !!res.promoted });
  return text(`Released the ${deps.repoName} dev environment${res.promoted ? ' — handed off to a waiting worker.' : '.'}`);
}

export function createWorkerToolServer(deps: WorkerToolDeps): { server: unknown; toolNames: string[] } {
  type ToolDef = NonNullable<Parameters<typeof createSdkMcpServer>[0]['tools']>[number];
  const tools: ToolDef[] = [
    tool('ask_user', 'Ask the human operator a question in this feature\'s thread and wait for their reply. Use whenever you need input, a decision, or clarification.',
      { question: z.string().describe('The question to ask the operator') },
      (a) => askUserHandler(deps, a) as Promise<CallToolResult>),
    tool('send_update', 'Post a progress update to the operator, optionally attaching files (specs, plans, diffs). Use to share artifacts or status.',
      { text: z.string(), files: z.array(z.string()).optional().describe('Absolute file paths to attach') },
      (a) => sendUpdateHandler(deps, a) as Promise<CallToolResult>),
    tool('finish', 'Propose that this feature is complete and post a summary for the operator to review. This does NOT end the work — the operator decides. They will either reply with more changes (keep going, call finish again when done) or close the thread themselves with /done.',
      { summary: z.string() },
      (a) => finishHandler(deps, a) as Promise<CallToolResult>),
  ];
  const toolNames = ['mcp__worker__ask_user', 'mcp__worker__send_update', 'mcp__worker__finish'];

  // The shared dev environment is exclusive per repo — only feature workers change code and
  // use it. Investigation workers are read-only, so they don't get (or need) these tools.
  if (deps.kind === 'feature') {
    tools.push(
      tool('claim_dev', 'Claim exclusive use of this repo\'s shared dev environment before you use it (dev server, migrations, seeds, deploying to dev, or tests that hit dev). Only one worker holds it at a time; if it\'s busy this blocks until it frees, then returns. Always call release_dev when you\'re done.',
        {}, (a) => claimDevHandler(deps, a) as Promise<CallToolResult>),
      tool('release_dev', 'Release this repo\'s shared dev environment so another worker can use it. Call this as soon as you no longer need it.',
        {}, (a) => releaseDevHandler(deps, a) as Promise<CallToolResult>),
    );
    toolNames.push('mcp__worker__claim_dev', 'mcp__worker__release_dev');
  }

  const server = createSdkMcpServer({ name: 'worker', version: '1.0.0', tools });
  return { server, toolNames };
}
