export type WorkerStatus = 'running' | 'waiting' | 'finished' | 'failed';

export type WorkerKind = 'feature' | 'investigation';

export type AlertSource = 'prometheus' | 'glitchtip';

export interface IngestChannel {
  channelId: string;
  source: AlertSource;
}

/** A monitoring event parsed from an ingest-channel post. */
export interface AlertEvent {
  fingerprint: string;
  status: 'firing' | 'resolved';
  source: AlertSource;
  service?: string;
  severity?: string;
  summary: string;
  sourceUrl?: string;
}

export type IncidentStatus = 'open' | 'resolved_upstream' | 'closed';

export interface IncidentRecord {
  id: string;
  fingerprint: string;
  source: AlertSource;
  service: string | null;
  repoName: string | null;
  threadRootId: string;
  workerId: string | null;
  status: IncidentStatus;
  summary: string;
  createdAt: number;
  lastSeenAt: number;
  refireCount: number;
}

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
  kind: WorkerKind;
  task: string;
  createdAt: number;
  updatedAt: number;
}
