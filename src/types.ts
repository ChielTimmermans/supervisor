export type WorkerStatus = 'running' | 'waiting' | 'finished' | 'failed';

export interface IncomingPost {
  id: string;
  channelId: string;
  rootId: string;      // '' for top-level, else the thread root post id
  message: string;
  userId: string;
  fileIds: string[];
  isOwn: boolean;      // authored by the bot itself
}

export interface WorkerRecord {
  id: string;
  threadRootId: string;
  repoName: string;
  repoPath: string;
  sessionId: string | null;
  status: WorkerStatus;
  task: string;
  createdAt: number;
  updatedAt: number;
}
