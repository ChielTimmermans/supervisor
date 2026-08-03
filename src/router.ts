import type { IncomingPost, WorkerRecord } from './types.js';

export type RouteAction =
  | { kind: 'supervisor' }
  | { kind: 'resolve_question'; workerId: string }
  | { kind: 'inject_worker'; workerId: string };

export interface RouterState {
  getWorkerByThread(threadRootId: string): WorkerRecord | undefined;
  hasOpenQuestion(workerId: string): boolean;
}

export function route(post: IncomingPost, state: RouterState): RouteAction {
  if (post.rootId === '') return { kind: 'supervisor' };
  const worker = state.getWorkerByThread(post.rootId);
  if (!worker) return { kind: 'supervisor' };
  if (state.hasOpenQuestion(worker.id)) return { kind: 'resolve_question', workerId: worker.id };
  return { kind: 'inject_worker', workerId: worker.id };
}
