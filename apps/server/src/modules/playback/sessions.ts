import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { OnlineSubtitlesResult } from '@lumiere/shared';
import { NotFoundError } from '../../core/errors';
import type { OnlineSubtitleCandidate } from '../subtitles/online-subtitles.service';
import type { PlaybackPlan } from './planner';

/** Instant réel où démarre un flux relancé (connu quand ffmpeg a atteint l'image clé). */
export interface StreamOrigin {
  promise: Promise<number>;
  settled: boolean;
  resolve: (start: number) => void;
  reject: (error: Error) => void;
}

export interface SubtitleSource {
  id: string;
  label: string;
  language: string | null;
  codec: string;
  source: 'embedded' | 'external' | 'online';
  supported: boolean;
  isDefault: boolean;
  isForced: boolean;
  streamIndex?: number;
  remotePath?: string;
  filePath?: string;
  format?: string;
  /** Sous-titres trouvés en ligne. */
  online?: OnlineSubtitleCandidate;
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
  /** Film ou épisode, et numéros d'épisode (recherche de sous-titres en ligne). */
  kind: 'movie' | 'series';
  season: number | null;
  episode: number | null;
  /** Taille du fichier en octets, si elle est connue. */
  size: number | null;
  title: string;
  subtitle: string | null;
  subtitles: SubtitleSource[];
  /** Recherche de sous-titres en ligne (faite une fois par session, à la demande). */
  onlineSearch: Promise<OnlineSubtitlesResult> | null;
  process: ChildProcess | null;
  /** Incrémenté à chaque demande de flux : une demande plus récente rend les autres caduques. */
  streamGeneration: number;
  /** Départ réel des derniers flux, par identifiant de flux choisi par le lecteur. */
  origins: Map<string, StreamOrigin>;
  subtitleCache: Map<string, Promise<string>>;
}

export type NewSession = Omit<
  PlaybackSessionState,
  | 'id'
  | 'createdAt'
  | 'lastAccess'
  | 'process'
  | 'streamGeneration'
  | 'origins'
  | 'subtitleCache'
  | 'onlineSearch'
>;

const SESSION_TTL_MS = 6 * 3600_000;
const MAX_ORIGINS = 16;
const PROCESS_EXIT_TIMEOUT_MS = 3000;

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
      streamGeneration: 0,
      origins: new Map(),
      subtitleCache: new Map(),
      onlineSearch: null,
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

  /**
   * Arrête le transcodage en cours d'une session (nouveau positionnement ou fermeture) et
   * attend sa fin : sa connexion à la source est fermée avant qu'un nouveau flux s'ouvre.
   */
  stopProcess(session: PlaybackSessionState): Promise<void> {
    const child = session.process;
    session.process = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, PROCESS_EXIT_TIMEOUT_MS);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGKILL');
    });
  }

  /** Départ réel du flux `streamId` (créé à la première demande, par le flux ou par le lecteur). */
  origin(session: PlaybackSessionState, streamId: string): StreamOrigin {
    const existing = session.origins.get(streamId);
    if (existing) return existing;
    let resolve: (start: number) => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    const promise = new Promise<number>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    // Personne n'attend forcément ce départ : un échec ne doit pas devenir un rejet non géré.
    promise.catch(() => undefined);
    const origin: StreamOrigin = {
      promise,
      settled: false,
      resolve: (start) => {
        origin.settled = true;
        resolve(start);
      },
      reject: (error) => {
        origin.settled = true;
        reject(error);
      },
    };
    session.origins.set(streamId, origin);
    for (const key of session.origins.keys()) {
      if (session.origins.size <= MAX_ORIGINS) break;
      session.origins.delete(key);
    }
    return origin;
  }

  delete(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    void this.stopProcess(session);
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
