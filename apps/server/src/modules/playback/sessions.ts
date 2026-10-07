import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { NotFoundError } from '../../core/errors';
import type { PlaybackPlan } from './planner';

export interface SubtitleSource {
  id: string;
  label: string;
  language: string | null;
  codec: string;
  source: 'embedded' | 'external';
  supported: boolean;
  isDefault: boolean;
  isForced: boolean;
  streamIndex?: number;
  remotePath?: string;
  filePath?: string;
  format?: string;
}

export interface PlaybackSessionState {
  id: string;
  createdAt: number;
  lastAccess: number;
  /** Chemin local ou URL distante passé à ffmpeg. */
  input: string;
  isRemote: boolean;
  remotePath: string | null;
  filePath: string | null;
  fileName: string;
  mimeType: string;
  plan: PlaybackPlan;
  duration: number | null;
  mediaKey: string;
  titleId: number | null;
  libraryItemId: number | null;
  title: string;
  subtitle: string | null;
  subtitles: SubtitleSource[];
  process: ChildProcess | null;
  subtitleCache: Map<string, Promise<string>>;
}

export type NewSession = Omit<
  PlaybackSessionState,
  'id' | 'createdAt' | 'lastAccess' | 'process' | 'subtitleCache'
>;

const SESSION_TTL_MS = 6 * 3600_000;

/** Sessions de lecture en mémoire (plan de lecture + processus ffmpeg en cours). */
export class PlaybackSessions {
  private readonly sessions = new Map<string, PlaybackSessionState>();
  private readonly timer: NodeJS.Timeout;

  constructor() {
    this.timer = setInterval(() => this.cleanup(), 60_000);
    this.timer.unref();
  }

  create(input: NewSession): PlaybackSessionState {
    const now = Date.now();
    const session: PlaybackSessionState = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      lastAccess: now,
      process: null,
      subtitleCache: new Map(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): PlaybackSessionState {
    const session = this.sessions.get(id);
    if (!session) throw new NotFoundError('Session de lecture expirée : relancez la lecture.');
    session.lastAccess = Date.now();
    return session;
  }

  /** Arrête le transcodage en cours d'une session (nouveau positionnement ou fermeture). */
  stopProcess(session: PlaybackSessionState): void {
    const child = session.process;
    session.process = null;
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
  }

  delete(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.stopProcess(session);
    this.sessions.delete(id);
  }

  closeAll(): void {
    clearInterval(this.timer);
    for (const id of [...this.sessions.keys()]) this.delete(id);
  }

  private cleanup(): void {
    const limit = Date.now() - SESSION_TTL_MS;
    for (const session of [...this.sessions.values()]) {
      if (session.lastAccess < limit) this.delete(session.id);
    }
  }
}
