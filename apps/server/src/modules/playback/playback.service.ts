import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  AudioTrackInfo,
  ContinueWatchingItem,
  MediaRef,
  PlaybackRequest,
  PlaybackSession,
  ProgressUpdate,
} from '@lumiere/shared';
import type { AppConfig } from '../../config/env';
import { TtlCache, sleep } from '../../core/async';
import {
  AppError,
  BadRequestError,
  NotFoundError,
  ServiceUnavailableError,
} from '../../core/errors';
import { ensureDir } from '../../core/fs';
import type { Logger } from '../../core/logger';
import { formatEpisodeCode, prettifyTitle } from '../../core/text';
import { parseEpisode, parseSeasonFolder } from '../../domain/episode-parser';
import { pickPreferredFile } from '../../domain/file-selection';
import {
  classifyFile,
  extensionOf,
  guessSubtitleLanguage,
  languageLabel,
  normalizeLanguageCode,
  stripExtension,
  videoMimeType,
} from '../../domain/media-files';
import { parseRelease } from '../../domain/release-parser';
import { mediaKeyForRemote } from '../availability/availability.service';
import type { CatalogService } from '../catalog/catalog.service';
import { backdropUrlFor, displayTitle, posterUrlFor } from '../catalog/presenters';
import type { TitleRow, TitlesRepository } from '../catalog/titles.repository';
import type { LibraryRow } from '../library/library.repository';
import { mediaKeyForLibraryRow, type LibraryService } from '../library/library.service';
import type { MetadataService } from '../metadata/metadata.service';
import type { SettingsService } from '../settings/settings.service';
import { normalizeRemotePath, remoteBaseName, remoteParent } from '../source/remote-path';
import type { SourceClient } from '../source/source-client';
import type { SourceRelay } from '../source/source-relay';
import { parseVirtualPath } from '../source/stremio/virtual-path';
import type { Ffmpeg, ProbeResult, ProbeStream } from './ffmpeg';
import { buildStreamArgs, buildSubtitleConvertArgs, buildSubtitleExtractArgs } from './ffmpeg-args';
import { planPlayback, type PlaybackPlan } from './planner';
import type { ProgressRepository } from './progress.repository';
import { proxyRemoteFile, sendLocalFile } from './streaming';
import type {
  PlaybackSessionState,
  PlaybackSessions,
  StreamOrigin,
  SubtitleSource,
} from './sessions';
import { StreamOriginReader } from './stream-origin';
import { TEXT_SUBTITLE_CODECS, decodeText, normalizeVtt, srtToVtt } from './subtitles';

interface ResolvedMedia {
  input: string;
  isRemote: boolean;
  remotePath: string | null;
  filePath: string | null;
  fileName: string;
  libraryRow: LibraryRow | null;
  titleRow: TitleRow | null;
  season: number | null;
  episode: number | null;
  episodeEnd: number | null;
}

const MAX_SUBTITLE_BYTES = 20 * 1024 * 1024;
/** Démarrages de ffmpeg tentés pour un même flux (source qui refuse un instant…). */
const STREAM_ATTEMPTS = 3;
const STREAM_RETRY_DELAY_MS = 1000;
const STREAM_ORIGIN_TIMEOUT_MS = 60_000;

/** Demande de flux abandonnée par le lecteur ou remplacée par un positionnement plus récent. */
function replaced(): AppError {
  return new AppError(409, 'STREAM_REPLACED', 'Flux remplacé par une demande plus récente.');
}

/** Premier octet demandé par un en-tête `Range` (0 sans en-tête ou s'il est illisible). */
function rangeStart(header: string | undefined): number {
  const match = /^bytes=(\d+)-/.exec(header ?? '');
  return match ? Number(match[1]) : 0;
}

function channelsLabel(channels: number | null): string | null {
  if (!channels) return null;
  return (
    ({ 1: 'mono', 2: 'stéréo', 6: '5.1', 8: '7.1' } as Record<number, string>)[channels] ??
    `${channels} canaux`
  );
}

const CODEC_LABELS: Record<string, string> = {
  aac: 'AAC',
  ac3: 'Dolby Digital',
  eac3: 'Dolby Digital+',
  dts: 'DTS',
  truehd: 'TrueHD',
  opus: 'Opus',
  mp3: 'MP3',
  flac: 'FLAC',
  vorbis: 'Vorbis',
};

/** Titre de piste utile à afficher (ignoré s'il ne fait que répéter la langue : « English », « VFF »…). */
function extraTitle(title: string | null, label: string): string {
  if (!title) return '';
  const lowered = title.toLowerCase();
  if (lowered.includes(label.toLowerCase()) || normalizeLanguageCode(title) !== null) return '';
  return ` – ${title}`;
}

function audioLabel(stream: ProbeStream, index: number): string {
  const language = languageLabel(stream.language) ?? `Piste ${index + 1}`;
  const details = [
    CODEC_LABELS[stream.codec ?? ''] ?? stream.codec?.toUpperCase(),
    channelsLabel(stream.channels),
  ]
    .filter(Boolean)
    .join(' ');
  return `${language}${extraTitle(stream.title, language)}${details ? ` (${details})` : ''}`;
}

function subtitleLabel(
  language: string | null,
  title: string | null,
  forced: boolean,
  fallback: string,
): string {
  const base = languageLabel(language) ?? fallback;
  return `${base}${extraTitle(title, base)}${forced ? ' (forcés)' : ''}`;
}

/** Orchestration de la lecture : sessions, plan de lecture, flux, sous-titres et progression. */
export class PlaybackService {
  private readonly probes = new TtlCache<string, ProbeResult>(300, 3600_000);

  constructor(
    private readonly ffmpeg: Ffmpeg,
    private readonly sessions: PlaybackSessions,
    private readonly source: SourceClient,
    private readonly relay: SourceRelay,
    private readonly library: LibraryService,
    private readonly catalog: CatalogService,
    private readonly titles: TitlesRepository,
    private readonly metadata: MetadataService,
    private readonly progress: ProgressRepository,
    private readonly settings: SettingsService,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  // -------------------------------------------------------------------------
  // Création de session
  // -------------------------------------------------------------------------

  async createSession(request: PlaybackRequest): Promise<PlaybackSession> {
    const media = await this.resolveMedia(request.media);
    const probe = await this.probe(media);
    const settings = this.settings.get();
    const plan: PlaybackPlan = probe
      ? planPlayback(probe, request.capabilities, {
          extension: extensionOf(media.fileName),
          audioTrack: request.audioTrack ?? null,
          preferredAudioLanguage: settings.preferredAudioLanguage,
          forceTranscode: request.mode === 'transcode',
          canEncodeH264: this.ffmpeg.info.hasLibx264,
          canEncodeVp9: this.ffmpeg.info.hasLibvpxVp9,
        })
      : {
          mode: 'direct',
          container: extensionOf(media.fileName),
          videoStream: null,
          audioStream: null,
          audioStreams: [],
          audioTrack: null,
          output: null,
          hdr: false,
          reasons: ['ffmpeg indisponible : lecture directe uniquement'],
        };

    const subtitles = [...this.embeddedSubtitles(probe), ...(await this.externalSubtitles(media))];
    const mediaKey = media.libraryRow
      ? mediaKeyForLibraryRow(media.libraryRow)
      : mediaKeyForRemote(media.remotePath as string);
    const { title, subtitle } = await this.describe(media);
    const mimeType = plan.mode === 'direct' ? videoMimeType(media.fileName) : 'video/mp4';

    const session = this.sessions.create({
      input: media.input,
      isRemote: media.isRemote,
      remotePath: media.remotePath,
      filePath: media.filePath,
      fileName: media.fileName,
      mimeType,
      plan,
      duration: probe?.duration ?? null,
      mediaKey,
      titleId: media.titleRow?.id ?? media.libraryRow?.title_id ?? null,
      libraryItemId: media.libraryRow?.id ?? null,
      title,
      subtitle,
      subtitles,
    });

    const saved = this.progress.get(mediaKey);
    const duration = probe?.duration ?? saved?.duration ?? null;
    const resumePosition =
      saved &&
      saved.completed === 0 &&
      saved.position > 30 &&
      (duration === null || saved.position < duration - 30)
        ? saved.position
        : 0;

    const enabled = this.metadata.isEnabled();
    const audioTracks: AudioTrackInfo[] = plan.audioStreams.map((stream, index) => ({
      index,
      label: audioLabel(stream, index),
      language: stream.language,
      codec: stream.codec ?? 'inconnu',
      channels: stream.channels,
      isDefault: stream.isDefault,
    }));

    this.logger.info(
      { session: session.id, file: media.fileName, mode: plan.mode, remote: media.isRemote },
      'Session de lecture créée',
    );

    return {
      sessionId: session.id,
      mode: plan.mode,
      streamUrl: `/api/playback/sessions/${session.id}/stream`,
      mimeType,
      seek: plan.mode === 'direct' ? 'native' : 'restart',
      duration,
      resumePosition,
      mediaKey,
      title,
      subtitle,
      titleId: session.titleId,
      posterUrl: media.titleRow ? posterUrlFor(media.titleRow, enabled) : null,
      backdropUrl: media.titleRow ? backdropUrlFor(media.titleRow, enabled) : null,
      audioTracks,
      selectedAudioTrack: plan.audioTrack,
      subtitleTracks: subtitles.map(
        ({ id, label, language, codec, source, supported, isDefault, isForced }) => ({
          id,
          label,
          language,
          codec,
          source,
          supported,
          isDefault,
          isForced,
        }),
      ),
      defaultSubtitleTrack: this.defaultSubtitle(subtitles, plan),
      video: plan.videoStream
        ? {
            codec: plan.videoStream.codec,
            width: plan.videoStream.width,
            height: plan.videoStream.height,
            hdr: plan.hdr,
          }
        : null,
      reasons: plan.reasons,
      next: await this.findNext(media).catch(() => null),
    };
  }

  private async resolveMedia(ref: MediaRef): Promise<ResolvedMedia> {
    if (ref.type === 'library') return this.fromLibraryRow(this.library.getRow(ref.id));
    if (ref.type === 'episode') return this.resolveEpisode(ref.titleId, ref.season, ref.episode);

    const remotePath = normalizeRemotePath(ref.path);
    if (remotePath.endsWith('/')) throw new BadRequestError('Un dossier ne peut pas être lu.');
    // Si le fichier a déjà été téléchargé, la copie locale est privilégiée.
    const local = this.library.findByRemotePath(remotePath);
    if (local && fs.existsSync(local.file_path)) return this.fromLibraryRow(local);

    const titleRow = this.titles.findContaining(remotePath) ?? null;
    const fileName = remoteBaseName(remotePath);
    const virtual = parseVirtualPath(remotePath);
    let ref2 =
      titleRow?.kind === 'series'
        ? parseEpisode(fileName, parseSeasonFolder(remoteBaseName(remoteParent(remotePath) ?? '')))
        : null;
    if (virtual?.season != null && virtual.episode != null) {
      // Fichier d'extension : l'épisode demandé fait foi (le nom du fichier peut être muet).
      const sameEpisode = ref2?.season === virtual.season && ref2.episode === virtual.episode;
      ref2 = {
        season: virtual.season,
        episode: virtual.episode,
        episodeEnd: sameEpisode ? (ref2?.episodeEnd ?? null) : null,
      };
    }
    return {
      // ffmpeg lit la source via le relais local (même transport que le reste de l'application).
      input: this.relay.urlFor(remotePath),
      isRemote: true,
      remotePath,
      filePath: null,
      fileName,
      libraryRow: null,
      titleRow,
      season: ref2?.season ?? null,
      episode: ref2?.episode ?? null,
      episodeEnd: ref2?.episodeEnd ?? null,
    };
  }

  /**
   * Épisode demandé sans fichier précis (extension Stremio) : copie locale si elle existe,
   * sinon la version préférée parmi celles que propose l'extension.
   */
  private async resolveEpisode(
    titleId: number,
    season: number,
    episode: number,
  ): Promise<ResolvedMedia> {
    const local = this.library.findEpisode(titleId, season, episode);
    if (local && fs.existsSync(local.file_path)) return this.fromLibraryRow(local);
    const { files, notice } = await this.catalog.episodeFiles(titleId, season, episode);
    const { preferredQuality, preferredAudioLanguage } = this.settings.get();
    const file = pickPreferredFile(files, preferredQuality, preferredAudioLanguage);
    if (!file) {
      throw new NotFoundError(
        notice ??
          `L’extension Stremio ne propose aucun fichier pour l’épisode ${formatEpisodeCode(season, episode) ?? episode}.`,
      );
    }
    return this.resolveMedia({ type: 'remote', path: file.path });
  }

  private fromLibraryRow(row: LibraryRow): ResolvedMedia {
    if (!fs.existsSync(row.file_path))
      throw new NotFoundError('Le fichier local est introuvable (déplacé ou supprimé ?).');
    const titleRow =
      (row.title_id !== null ? this.titles.findById(row.title_id) : undefined) ??
      (row.remote_path ? this.titles.findContaining(row.remote_path) : undefined) ??
      null;
    const ref = parseEpisode(row.file_name, row.season);
    return {
      input: row.file_path,
      isRemote: false,
      remotePath: row.remote_path,
      filePath: row.file_path,
      fileName: row.file_name,
      libraryRow: row,
      titleRow,
      season: row.season,
      episode: row.episode,
      episodeEnd: ref.episodeEnd,
    };
  }

  private async describe(
    media: ResolvedMedia,
  ): Promise<{ title: string; subtitle: string | null }> {
    const release = parseRelease(media.fileName);
    const isEpisode = media.titleRow?.kind === 'series' || media.libraryRow?.kind === 'episode';
    const title = media.titleRow
      ? displayTitle(media.titleRow)
      : (media.libraryRow?.title ?? prettifyTitle(release.title || stripExtension(media.fileName)));
    if (isEpisode) {
      let episodeName: string | null = null;
      if (media.titleRow && media.season !== null && media.episode !== null) {
        const season = await this.metadata.season(media.titleRow, media.season);
        episodeName =
          season?.episodes.find((item) => item.episode_number === media.episode)?.name ?? null;
      }
      const code = formatEpisodeCode(media.season, media.episode, media.episodeEnd);
      return { title, subtitle: [code, episodeName].filter(Boolean).join(' · ') || null };
    }
    const year = media.titleRow?.year ?? media.libraryRow?.year ?? release.year;
    return { title, subtitle: year ? String(year) : null };
  }

  private async probe(media: ResolvedMedia): Promise<ProbeResult | null> {
    if (!this.ffmpeg.info.ffprobeAvailable) return null;
    // Fichier distant : clé stable (le relais local change d'URL à chaque démarrage).
    let key = media.isRemote && media.remotePath ? `remote:${media.remotePath}` : media.input;
    if (!media.isRemote) {
      const stats = await fsp.stat(media.input);
      key += `:${stats.size}:${stats.mtimeMs}`;
    }
    const cached = this.probes.get(key);
    if (cached) return cached;
    const result = await this.ffmpeg.probe(media.input, { userAgent: this.source.userAgent });
    this.probes.set(key, result);
    return result;
  }

  private embeddedSubtitles(probe: ProbeResult | null): SubtitleSource[] {
    if (!probe) return [];
    return probe.streams
      .filter((stream) => stream.type === 'subtitle')
      .map((stream, index) => ({
        id: `emb-${stream.index}`,
        label: subtitleLabel(
          stream.language,
          stream.title,
          stream.isForced,
          `Sous-titres ${index + 1}`,
        ),
        language: stream.language,
        codec: stream.codec ?? 'inconnu',
        source: 'embedded' as const,
        supported: TEXT_SUBTITLE_CODECS.has(stream.codec ?? ''),
        isDefault: stream.isDefault,
        isForced: stream.isForced,
        streamIndex: stream.index,
      }));
  }

  /** Sous-titres externes (.srt, .vtt, .ass) rangés à côté de la vidéo, en local ou sur la source. */
  private async externalSubtitles(media: ResolvedMedia): Promise<SubtitleSource[]> {
    const stem = stripExtension(media.fileName).toLowerCase();
    let candidates: Array<{ name: string; remotePath?: string; filePath?: string }> = [];
    let videoCount = 0;

    if (media.filePath) {
      const dir = path.dirname(media.filePath);
      const names = await fsp.readdir(dir).catch(() => [] as string[]);
      videoCount = names.filter((name) => classifyFile(name) === 'video').length;
      candidates = names
        .filter((name) => classifyFile(name) === 'subtitle')
        .map((name) => ({ name, filePath: path.join(dir, name) }));
    }
    if (candidates.length === 0 && media.remotePath) {
      const listing = await this.source
        .list(remoteParent(media.remotePath) ?? '/')
        .catch(() => null);
      const entries = listing?.entries.filter((entry) => !entry.isDirectory) ?? [];
      videoCount = entries.filter((entry) => classifyFile(entry.name) === 'video').length;
      candidates = entries
        .filter((entry) => classifyFile(entry.name) === 'subtitle')
        .map((entry) => ({ name: entry.name, remotePath: entry.path }));
    }

    const code = formatEpisodeCode(media.season, media.episode)?.toLowerCase();
    return candidates
      .filter(
        (candidate) =>
          videoCount <= 1 ||
          candidate.name.toLowerCase().startsWith(stem) ||
          (code !== undefined && code !== null && candidate.name.toLowerCase().includes(code)),
      )
      .map((candidate, index) => {
        const format = extensionOf(candidate.name);
        const language = guessSubtitleLanguage(candidate.name);
        const forced = /forced|forc[ée]s?/i.test(candidate.name);
        return {
          id: `ext-${index}`,
          label: subtitleLabel(language, null, forced, stripExtension(candidate.name)),
          language,
          codec: format,
          source: 'external' as const,
          supported: ['srt', 'vtt', 'ass', 'ssa'].includes(format),
          isDefault: false,
          isForced: forced,
          remotePath: candidate.remotePath,
          filePath: candidate.filePath,
          format,
        };
      });
  }

  private defaultSubtitle(subtitles: SubtitleSource[], plan: PlaybackPlan): string | null {
    const usable = subtitles.filter((track) => track.supported);
    const preferred = this.settings.get().preferredSubtitleLanguage;
    if (preferred) {
      const match =
        usable.find((track) => track.language === preferred && !track.isForced) ??
        usable.find((track) => track.language === preferred);
      if (match) return match.id;
    }
    // Sous-titres « forcés » (passages en langue étrangère) dans la langue de l'audio.
    const audioLanguage = plan.audioStream?.language;
    const forced = usable.find(
      (track) => track.isForced && (!audioLanguage || track.language === audioLanguage),
    );
    return forced?.id ?? null;
  }

  /** Épisode suivant : d'abord dans la bibliothèque locale, sinon sur la source. */
  private async findNext(media: ResolvedMedia): Promise<PlaybackSession['next']> {
    if (media.libraryRow?.kind === 'episode') {
      const episodes = this.library.listEpisodes(media.libraryRow);
      const index = episodes.findIndex((row) => row.id === media.libraryRow?.id);
      const next = index >= 0 ? episodes[index + 1] : undefined;
      if (next) {
        return {
          media: { type: 'library', id: next.id },
          label: formatEpisodeCode(next.season, next.episode) ?? next.file_name,
        };
      }
    }
    if (media.titleRow?.kind !== 'series') return null;
    if (this.catalog.addonMode) {
      // Épisode suivant d'après TMDB : son fichier ne sera demandé qu'à la lecture.
      if (media.season === null || media.episode === null) return null;
      const next = await this.catalog.nextEpisode(
        media.titleRow,
        media.season,
        media.episodeEnd ?? media.episode,
      );
      if (!next) return null;
      return {
        media: {
          type: 'episode',
          titleId: media.titleRow.id,
          season: next.season,
          episode: next.episode,
        },
        label: formatEpisodeCode(next.season, next.episode) ?? `Épisode ${next.episode}`,
      };
    }
    if (!media.remotePath) return null;
    const structure = await this.catalog.seriesStructure(media.titleRow);
    const episodes = structure.flatMap((season) => season.episodes);
    const index = episodes.findIndex((episode) =>
      episode.files.some((file) => file.path === media.remotePath),
    );
    const next = index >= 0 ? episodes[index + 1] : undefined;
    if (!next) return null;
    const currentResolution = parseRelease(media.fileName).info.resolution;
    const sameQuality = next.files.find(
      (file) => parseRelease(file.name).info.resolution === currentResolution,
    );
    const { preferredQuality, preferredAudioLanguage } = this.settings.get();
    const file =
      sameQuality ?? pickPreferredFile(next.files, preferredQuality, preferredAudioLanguage);
    if (!file) return null;
    return {
      media: { type: 'remote', path: file.path },
      label:
        formatEpisodeCode(next.season, next.episode, next.episodeEnd) ?? stripExtension(file.name),
    };
  }

  // -------------------------------------------------------------------------
  // Flux vidéo
  // -------------------------------------------------------------------------

  async stream(
    sessionId: string,
    start: number,
    streamId: string | undefined,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const session = this.sessions.get(sessionId);
    if (session.plan.mode === 'direct') {
      if (session.isRemote && session.remotePath) {
        return proxyRemoteFile(request, reply, this.source, session.remotePath, session.mimeType);
      }
      return sendLocalFile(request, reply, session.filePath as string, {
        contentType: session.mimeType,
      });
    }
    if (!this.ffmpeg.info.available) {
      throw new ServiceUnavailableError(
        'FFMPEG_UNAVAILABLE',
        'ffmpeg est nécessaire pour lire ce fichier.',
      );
    }

    reply.header('cache-control', 'no-store').header('accept-ranges', 'none');
    // Flux produit à la volée : il ne reprend pas au milieu. Le navigateur qui en redemande la
    // suite reçoit un refus net, et le lecteur relance le flux à la bonne position.
    if (rangeStart(request.headers.range) > 0) return reply.code(416).send();
    if (request.method === 'HEAD') return reply.header('content-type', 'video/mp4').send();

    const generation = ++session.streamGeneration;
    const origin = streamId ? this.sessions.origin(session, streamId) : null;
    const startAt = Math.max(0, start);
    let closed = false;
    const abandoned = () => {
      const error = replaced();
      // Le lecteur qui attend encore ce départ ne doit pas garder sa requête ouverte.
      if (origin && !origin.settled) origin.reject(error);
      return error;
    };
    reply.raw.on('close', () => {
      closed = true;
      if (session.streamGeneration === generation) void this.sessions.stopProcess(session);
    });

    let failure = 'erreur inconnue';
    for (let attempt = 1; attempt <= STREAM_ATTEMPTS; attempt += 1) {
      // Un seul ffmpeg par session : l'ancien est arrêté (et sa connexion à la source fermée).
      await this.sessions.stopProcess(session);
      if (attempt > 1) await sleep(STREAM_RETRY_DELAY_MS * (attempt - 1));
      if (closed || session.streamGeneration !== generation) throw abandoned();
      const started = await this.startTranscoder(session, startAt, origin);
      if (closed || session.streamGeneration !== generation) {
        if (started.ok && started.child.exitCode === null) started.child.kill('SIGKILL');
        throw abandoned();
      }
      if (started.ok) {
        return reply
          .header('content-type', 'video/mp4')
          .header('x-stream-start', String(startAt))
          .send(started.child.stdout);
      }
      failure = started.error;
      this.logger.warn(
        { session: session.id, attempt, start: startAt, detail: failure },
        'Démarrage de la conversion impossible',
      );
    }
    const error = new AppError(
      502,
      'TRANSCODE_FAILED',
      `La conversion vidéo a échoué : ${failure}`,
    );
    if (origin && !origin.settled) origin.reject(error);
    throw error;
  }

  /**
   * Lance ffmpeg et attend ses premiers octets : un processus qui s'arrête avant d'avoir
   * produit quoi que ce soit (source injoignable…) est un échec, jamais un flux vide.
   */
  private async startTranscoder(
    session: PlaybackSessionState,
    start: number,
    origin: StreamOrigin | null,
  ): Promise<
    | { ok: true; child: ChildProcessByStdio<null, Readable, Readable> }
    | { ok: false; error: string }
  > {
    const settings = this.settings.get();
    const args = buildStreamArgs({
      input: session.input,
      isRemote: session.isRemote,
      userAgent: this.source.userAgent,
      start,
      plan: session.plan,
      preset: settings.transcodePreset,
      maxHeight: settings.maxTranscodeHeight,
      canTonemap: this.ffmpeg.info.hasZscale,
    });
    const copiedVideo = session.plan.output?.video === 'copy' && session.plan.videoStream !== null;
    const child = spawn(this.ffmpeg.ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    session.process = child;
    const reader = new StreamOriginReader(start, (value) => {
      if (origin && !origin.settled) origin.resolve(value);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => reader.push(chunk));

    const ready = await new Promise<boolean>((resolve) => {
      const onReadable = () => {
        const chunk: unknown = child.stdout.read();
        if (chunk === null) {
          // Fin de flux sans données : ffmpeg s'est arrêté.
          resolve(false);
          return;
        }
        child.stdout.unshift(chunk as Buffer);
        resolve(true);
      };
      child.stdout.once('readable', onReadable);
      child.once('error', () => resolve(false));
      child.once('close', () => resolve(false));
    });
    if (!ready) {
      if (child.exitCode === null) child.kill('SIGKILL');
      return { ok: false, error: reader.lastError ?? 'ffmpeg s’est arrêté sans rien produire' };
    }
    // Vidéo réencodée : ffmpeg se positionne à l'image près, le flux part de la position demandée.
    if (origin && !origin.settled && !copiedVideo) origin.resolve(start);
    child.on('close', (code) => {
      if (code && code !== 255 && session.process === child) {
        this.logger.warn(
          { session: session.id, code, detail: reader.lastError },
          'ffmpeg terminé en erreur',
        );
      }
      // Départ jamais signalé (sortie framecrc absente) : la position demandée reste la meilleure estimation.
      if (origin && !origin.settled) origin.resolve(start);
    });
    return { ok: true, child };
  }

  /** Instant réel où démarre le flux `streamId` (image clé atteinte en recopie vidéo). */
  async streamOrigin(sessionId: string, streamId: string): Promise<number> {
    const session = this.sessions.get(sessionId);
    const origin = this.sessions.origin(session, streamId);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new AppError(504, 'STREAM_ORIGIN_TIMEOUT', 'Le flux vidéo n’a pas encore démarré.'),
          ),
        STREAM_ORIGIN_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([origin.promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  stopSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  // -------------------------------------------------------------------------
  // Sous-titres
  // -------------------------------------------------------------------------

  async subtitles(sessionId: string, trackId: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    const track = session.subtitles.find((item) => item.id === trackId);
    if (!track) throw new NotFoundError('Piste de sous-titres introuvable.');
    if (!track.supported)
      throw new BadRequestError('Ce format de sous-titres (image) ne peut pas être affiché.');
    let pending = session.subtitleCache.get(trackId);
    if (!pending) {
      pending = this.loadSubtitles(session, track);
      session.subtitleCache.set(trackId, pending);
      pending.catch(() => session.subtitleCache.delete(trackId));
    }
    return pending;
  }

  private async loadSubtitles(
    session: PlaybackSessionState,
    track: SubtitleSource,
  ): Promise<string> {
    if (track.source === 'external') {
      const buffer = track.remotePath
        ? await this.source.fetchBuffer(track.remotePath)
        : await fsp.readFile(track.filePath as string);
      const text = decodeText(buffer);
      if (track.format === 'srt') return srtToVtt(text);
      if (track.format === 'vtt') return normalizeVtt(text);
      return this.runFfmpegText(
        buildSubtitleConvertArgs(track.format === 'ssa' ? 'ass' : (track.format ?? 'ass')),
        Buffer.from(text, 'utf8'),
      );
    }

    // Piste intégrée : extraction (mise en cache disque, l'opération lit tout le fichier).
    let cacheKey = `${
      session.isRemote && session.remotePath ? `remote:${session.remotePath}` : session.input
    }#${track.streamIndex}`;
    if (!session.isRemote) {
      const stats = await fsp.stat(session.input);
      cacheKey += `:${stats.size}:${stats.mtimeMs}`;
    }
    const cacheFile = path.join(
      this.config.cacheDir,
      'subtitles',
      `${createHash('sha1').update(cacheKey).digest('hex')}.vtt`,
    );
    const cached = await fsp.readFile(cacheFile, 'utf8').catch(() => null);
    if (cached) return cached;
    if (!this.ffmpeg.info.available) {
      throw new ServiceUnavailableError(
        'FFMPEG_UNAVAILABLE',
        'ffmpeg est nécessaire pour extraire ces sous-titres.',
      );
    }
    const vtt = normalizeVtt(
      await this.runFfmpegText(
        buildSubtitleExtractArgs(
          session.input,
          track.streamIndex as number,
          session.isRemote,
          this.source.userAgent,
        ),
      ),
    );
    await ensureDir(path.dirname(cacheFile));
    await fsp.writeFile(cacheFile, vtt, 'utf8');
    return vtt;
  }

  private runFfmpegText(args: string[], stdin?: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ffmpeg.ffmpegPath, args, {
        stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const { stdout, stderr: errorStream } = child;
      if (!stdout || !errorStream) {
        reject(new AppError(500, 'SUBTITLE_FAILED', 'Impossible de lancer ffmpeg.'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let stderr = '';
      stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_SUBTITLE_BYTES) child.kill('SIGKILL');
        else chunks.push(chunk);
      });
      errorStream
        .setEncoding('utf8')
        .on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-2000)));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
        else
          reject(
            new AppError(
              500,
              'SUBTITLE_FAILED',
              `Extraction des sous-titres impossible : ${stderr.trim().split('\n').at(-1) ?? code}`,
            ),
          );
      });
      if (stdin && child.stdin) {
        child.stdin.on('error', () => undefined);
        child.stdin.end(stdin);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Progression de visionnage
  // -------------------------------------------------------------------------

  saveProgress(sessionId: string, update: ProgressUpdate): void {
    const session = this.sessions.get(sessionId);
    const duration = update.duration ?? session.duration;
    const position = Math.max(0, update.position);
    this.progress.upsert({
      media_key: session.mediaKey,
      title_id: session.titleId,
      library_item_id: session.libraryItemId,
      remote_path: session.remotePath,
      title: session.title,
      subtitle: session.subtitle,
      position,
      duration,
      completed: duration && position / duration >= 0.92 ? 1 : 0,
    });
  }

  continueWatching(limit = 20): ContinueWatchingItem[] {
    const rows = this.progress.inProgress(limit * 2);
    const titleIds = [
      ...new Set(rows.map((row) => row.title_id).filter((id): id is number => id !== null)),
    ];
    const titles = new Map(this.titles.findByIds(titleIds).map((title) => [title.id, title]));
    const enabled = this.metadata.isEnabled();
    const items: ContinueWatchingItem[] = [];
    for (const row of rows) {
      // Une référence distante est automatiquement lue depuis la copie locale si elle existe.
      let media: MediaRef | null = row.remote_path
        ? { type: 'remote', path: row.remote_path }
        : null;
      if (!media && row.library_item_id !== null) {
        const local = this.library.findRow(row.library_item_id);
        if (local && fs.existsSync(local.file_path)) media = { type: 'library', id: local.id };
      }
      if (!media) continue;
      const title = row.title_id !== null ? titles.get(row.title_id) : undefined;
      items.push({
        mediaKey: row.media_key,
        media,
        title: row.title,
        subtitle: row.subtitle,
        titleId: row.title_id,
        posterUrl: title ? posterUrlFor(title, enabled) : null,
        backdropUrl: title ? backdropUrlFor(title, enabled) : null,
        position: row.position,
        duration: row.duration,
        updatedAt: row.updated_at,
      });
      if (items.length >= limit) break;
    }
    return items;
  }

  removeProgress(mediaKey: string): void {
    this.progress.delete(mediaKey);
  }

  /** Marque un média comme vu / non vu. */
  setWatched(ref: MediaRef, watched: boolean): void {
    let mediaKey: string;
    let remotePath: string | null;
    let libraryRow: LibraryRow | null = null;
    if (ref.type === 'library') {
      libraryRow = this.library.getRow(ref.id);
      mediaKey = mediaKeyForLibraryRow(libraryRow);
      remotePath = libraryRow.remote_path;
    } else if (ref.type === 'episode') {
      throw new BadRequestError('Choisissez une version de l’épisode pour la marquer comme vue.');
    } else {
      remotePath = normalizeRemotePath(ref.path);
      mediaKey = mediaKeyForRemote(remotePath);
    }
    if (!watched) {
      this.progress.delete(mediaKey);
      return;
    }
    const existing = this.progress.get(mediaKey);
    const titleRow = remotePath ? this.titles.findContaining(remotePath) : undefined;
    const fileName = libraryRow?.file_name ?? remoteBaseName(remotePath ?? '');
    this.progress.upsert({
      media_key: mediaKey,
      title_id: titleRow?.id ?? libraryRow?.title_id ?? null,
      library_item_id: libraryRow?.id ?? null,
      remote_path: remotePath,
      title:
        existing?.title ?? (titleRow ? displayTitle(titleRow) : (libraryRow?.title ?? fileName)),
      subtitle: existing?.subtitle ?? null,
      position: existing?.duration ?? existing?.position ?? 0,
      duration: existing?.duration ?? null,
      completed: 1,
    });
  }
}
