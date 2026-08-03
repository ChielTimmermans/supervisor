import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';

export class PendingQuestions {
  private resolvers = new Map<string, { questionId: string; resolve: (answer: string) => void }>();
  constructor(private db: Db) {}

  ask(args: { workerId: string; questionPostId: string }): Promise<string> {
    const questionId = randomUUID();
    this.db.addPendingQuestion({ id: questionId, workerId: args.workerId, questionPostId: args.questionPostId });
    return new Promise<string>((resolve) => {
      this.resolvers.set(args.workerId, { questionId, resolve });
    });
  }

  resolve(workerId: string, answer: string): boolean {
    const entry = this.resolvers.get(workerId);
    const open = this.db.getOpenQuestionForWorker(workerId);
    if (!entry && !open) return false;
    if (open) this.db.resolvePendingQuestion(open.id, answer);
    if (entry) {
      this.resolvers.delete(workerId);
      entry.resolve(answer);
    }
    return true;
  }

  hasOpen(workerId: string): boolean {
    return this.resolvers.has(workerId) || this.db.getOpenQuestionForWorker(workerId) !== undefined;
  }

  /** Drop a pending question without delivering an answer (used when a worker is force-closed). */
  cancel(workerId: string): void {
    this.resolvers.delete(workerId);
    const open = this.db.getOpenQuestionForWorker(workerId);
    if (open) this.db.resolvePendingQuestion(open.id, '(closed)');
  }
}
