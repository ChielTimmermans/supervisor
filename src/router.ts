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
  // Only an active worker can take a reply. A finished/failed thread's worker
  // is no longer live, so route to the supervisor instead of injecting into a
  // dead worker (which would silently drop the message).
  if (!worker || (worker.status !== 'running' && worker.status !== 'waiting')) return { kind: 'supervisor' };
  if (state.hasOpenQuestion(worker.id)) return { kind: 'resolve_question', workerId: worker.id };
  return { kind: 'inject_worker', workerId: worker.id };
}
