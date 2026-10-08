import {
  ArrowLeft,
  AudioLines,
  Captions,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import type {
  MediaRef,
  OnlineSubtitlesResult,
  PlaybackSession,
  SubtitleTrackInfo,
} from '@lumiere/shared';
import { api, errorMessage } from '../../api/client';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { Glass } from '../../design/glass/Glass';
import { detectCapabilities } from '../../lib/capabilities';
import { cn } from '../../lib/cn';
import { formatClock } from '../../lib/format';
import { mediaFromSearch, playerUrl } from '../../lib/routes';
import { activeCues, parseVtt, type Cue } from '../../lib/vtt';
import { ProgressSlider } from './ProgressSlider';
import { TrackMenu } from './TrackMenu';

/** 0 = automatique, 1 = lecture directe désactivée (remultiplexage), 2 = conversion forcée. */
type FallbackLevel = 0 | 1 | 2;

/** Les positionnements rapprochés (±10 s répétés) sont regroupés en une seule relance du flux. */
const SEEK_DEBOUNCE_MS = 350;
/** Reprises automatiques d'un flux interrompu, au plus MAX_RECOVERIES par fenêtre glissante. */
const MAX_RECOVERIES = 3;
const RECOVERY_WINDOW_MS = 60_000;

/** Pas du décalage des sous-titres (touches G et H). */
const SUBTITLE_DELAY_STEP = 0.25;
/** Entrées du menu des sous-titres qui ne sont pas des pistes. */
const SEARCH_ONLINE_AGAIN = '__search-again';
const MENU_NOTE = '__note';

type OnlineStatus = 'idle' | 'searching' | 'done' | 'error';

function formatDelay(seconds: number): string {
  const value = `${Math.abs(seconds).toFixed(2).replace('.', ',')} s`;
  return seconds === 0 ? '0 s' : `${seconds > 0 ? '+' : '−'}${value}`;
}

/** Détail d'une piste de sous-titres affiché sous son nom dans le menu. */
function subtitleHint(track: SubtitleTrackInfo): string {
  if (track.source === 'online') {
    return [
      track.provider ?? 'En ligne',
      track.hashMatch && 'fait pour ce fichier',
      track.downloads ? `${track.downloads.toLocaleString('fr-FR')} téléchargements` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }
  return `${track.source === 'embedded' ? 'Intégrés' : 'Fichier externe'} · ${track.codec.toUpperCase()}${track.supported ? '' : ' (format image non pris en charge)'}`;
}

let streamCounter = 0;
/** Identifiant d'un chargement du flux (le serveur y rattache l'instant réel de départ). */
function newStreamId(): string {
  streamCounter += 1;
  return `${Date.now().toString(36)}-${streamCounter}`;
}

const MODE_LABELS: Record<PlaybackSession['mode'], string> = {
  direct: 'Lecture directe',
  remux: 'Remultiplexé',
  transcode: 'Conversion',
};

function readStored(key: string, fallback: number): number {
  try {
    const value = Number(localStorage.getItem(key));
    return localStorage.getItem(key) === null || Number.isNaN(value) ? fallback : value;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Stockage indisponible (navigation privée) : préférence non mémorisée.
  }
}

export function PlayerPage() {
  const [params] = useSearchParams();
  const media = mediaFromSearch(params);
  const start = params.has('t') ? Number(params.get('t')) : null;
  if (!media) return <PlayerFailure message="Aucun média à lire." />;
  return (
    <Player
      key={JSON.stringify(media)}
      media={media}
      initialStart={Number.isFinite(start) ? start : null}
    />
  );
}

function Player({ media, initialStart }: { media: MediaRef; initialStart: number | null }) {
  const navigate = useNavigate();
  const container = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);

  const [session, setSession] = useState<PlaybackSession | null>(null);
  const [level, setLevel] = useState<FallbackLevel>(0);
  const [src, setSrc] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [time, setTime] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [volume, setVolume] = useState(() => readStored('lumiere.volume', 1));
  const [muted, setMuted] = useState(() => readStored('lumiere.muted', 0) === 1);
  const [fullscreen, setFullscreen] = useState(false);
  const [controls, setControls] = useState(true);
  const [subtitleId, setSubtitleId] = useState<string | null>(null);
  const [loadedCues, setLoadedCues] = useState<Record<string, Cue[]>>({});
  /** Décalage des sous-titres en secondes (positif : plus tard). */
  const [subtitleDelay, setSubtitleDelay] = useState(0);
  const [onlineTracks, setOnlineTracks] = useState<SubtitleTrackInfo[]>([]);
  const [onlineStatus, setOnlineStatus] = useState<OnlineStatus>('idle');
  const [onlineNotices, setOnlineNotices] = useState<string[]>([]);
  /** Message bref affiché dans l'image (décalage des sous-titres…), sans couvrir les commandes. */
  const [osd, setOsd] = useState<{
    text: string;
    detail?: string;
    at: number;
    durationMs: number;
  } | null>(null);
  const showOsd = useCallback((text: string, detail?: string, durationMs = 2500) => {
    setOsd({ text, detail, at: Date.now(), durationMs });
  }, []);
  const [nextCountdown, setNextCountdown] = useState<number | null>(null);
  const [resumeNotice, setResumeNotice] = useState<number | null>(null);

  const pendingSeek = useRef<number | null>(null);
  /** Flux affiché : les événements d'un flux remplacé sont ignorés. */
  const streamId = useRef<string | null>(null);
  /** Position visée par un positionnement pas encore lancé (regroupement des appuis). */
  const seekTarget = useRef<number | null>(null);
  const seekFrom = useRef(0);
  const seekTimer = useRef<number | undefined>(undefined);
  /** Le flux de la session a déjà été lu : une erreur est alors une coupure, pas un format illisible. */
  const hasPlayed = useRef(false);
  const recoveries = useRef<number[]>([]);
  /** Raison de l'échec du dernier flux, donnée par le serveur. */
  const streamFailure = useRef<string | null>(null);
  /** Demande en cours de l'instant de départ (annulée quand le flux est remplacé). */
  const originRequest = useRef<AbortController | null>(null);
  /** L'utilisateur a choisi lui-même ses sous-titres : plus de choix automatique. */
  const subtitlePicked = useRef(false);
  const onlineSearched = useRef(false);
  const timeRef = useRef(0);
  const sessionRef = useRef<PlaybackSession | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const menuOpen = useRef(false);
  const onMenuOpenChange = useCallback((open: boolean) => {
    menuOpen.current = open;
  }, []);

  const duration = session?.duration ?? null;

  // -------------------------------------------------------------------------
  // Session et flux
  // -------------------------------------------------------------------------

  const createSession = useCallback(
    async (fallback: FallbackLevel, audioTrack: number | null) => {
      const capabilities = detectCapabilities();
      return api<PlaybackSession>('/playback/sessions', {
        method: 'POST',
        body: {
          media,
          capabilities: fallback >= 1 ? { ...capabilities, containers: [] } : capabilities,
          audioTrack,
          mode: fallback >= 2 ? 'transcode' : 'auto',
        },
      });
    },
    [media],
  );

  /**
   * Charge le flux d'une session à une position donnée (seek natif ou relance du flux).
   * `forwardFrom` : position quittée par un saut en avant ; si l'image clé atteinte la
   * précède (images clés très espacées), le flux est relancé plus loin.
   */
  const loadStream = useCallback(function load(
    target: PlaybackSession,
    position: number,
    forwardFrom: number | null = null,
  ) {
    const id = newStreamId();
    streamId.current = id;
    originRequest.current?.abort();
    originRequest.current = null;
    seekTarget.current = null;
    window.clearTimeout(seekTimer.current);
    streamFailure.current = null;
    setBuffering(true);
    if (target.seek === 'native') {
      pendingSeek.current = position > 0 ? position : null;
      setOffset(0);
      setSrc(`${target.streamUrl}?stream=${id}`);
      return;
    }
    const startAt = Math.max(0, position);
    pendingSeek.current = null;
    // Départ provisoire : le serveur indique ensuite l'instant réel (image clé atteinte).
    setOffset(startAt);
    timeRef.current = startAt;
    setTime(startAt);
    setSrc(`${target.streamUrl}?start=${startAt.toFixed(3)}&stream=${id}`);
    const request = new AbortController();
    originRequest.current = request;
    api<{ start: number }>(`/playback/sessions/${target.sessionId}/streams/${id}/origin`, {
      signal: request.signal,
    })
      .then(({ start }) => {
        if (streamId.current !== id) return;
        const further = startAt + (startAt - start) + 1;
        if (
          forwardFrom !== null &&
          start <= forwardFrom + 1 &&
          (target.duration === null || further < target.duration - 1)
        ) {
          load(target, further);
          return;
        }
        setOffset(start);
        const element = video.current;
        const elapsed = element?.currentSrc.includes(id) ? element.currentTime : 0;
        timeRef.current = start + elapsed;
        setTime(start + elapsed);
      })
      .catch((failure: unknown) => {
        if (streamId.current === id) streamFailure.current = errorMessage(failure);
      });
  }, []);

  /**
   * Recherche de sous-titres en ligne pour la session. `autoLanguage` : langue préférée absente
   * du fichier, dont le meilleur résultat est choisi si l'utilisateur n'a rien choisi.
   */
  const searchOnline = useCallback(
    async (
      target: PlaybackSession,
      options: { force?: boolean; autoLanguage?: string | null } = {},
    ) => {
      if (!target.onlineSubtitles.available) return;
      onlineSearched.current = true;
      setOnlineStatus('searching');
      try {
        const result = await api<OnlineSubtitlesResult>(
          `/playback/sessions/${target.sessionId}/subtitles/online`,
          { query: { force: options.force ? 'true' : undefined } },
        );
        if (sessionRef.current?.sessionId !== target.sessionId) return;
        setOnlineTracks(result.tracks);
        setOnlineNotices(result.notices);
        setOnlineStatus('done');
        const best = options.autoLanguage
          ? result.tracks.find((track) => track.language === options.autoLanguage)
          : undefined;
        if (best && !subtitlePicked.current) {
          setSubtitleId(best.id);
          showOsd('Sous-titres trouvés en ligne', `${best.label} · ${subtitleHint(best)}`, 5000);
        }
      } catch (failure) {
        if (sessionRef.current?.sessionId !== target.sessionId) return;
        setOnlineStatus('error');
        setOnlineNotices([errorMessage(failure)]);
      }
    },
    [showOsd],
  );

  const activate = useCallback(
    async (fallback: FallbackLevel, audioTrack: number | null, position: number) => {
      const previous = sessionRef.current;
      const next = await createSession(fallback, audioTrack);
      sessionRef.current = next;
      hasPlayed.current = false;
      setSession(next);
      setLevel(fallback);
      loadStream(next, position);
      // Les sous-titres en ligne déjà trouvés sont rattachés à la nouvelle session.
      if (onlineSearched.current) void searchOnline(next);
      // L'ancienne session (et sa conversion éventuelle) n'a plus d'usage.
      if (previous && previous.sessionId !== next.sessionId) {
        void api(`/playback/sessions/${previous.sessionId}`, { method: 'DELETE' }).catch(
          () => undefined,
        );
      }
      return next;
    },
    [createSession, loadStream, searchOnline],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const first = await createSession(0, null);
        if (cancelled) return;
        sessionRef.current = first;
        setSession(first);
        setSubtitleId(first.defaultSubtitleTrack);
        const position = initialStart ?? first.resumePosition;
        loadStream(first, position);
        // Langue de sous-titres préférée absente du fichier : on la cherche en ligne.
        if (first.onlineSubtitles.autoLanguage)
          void searchOnline(first, { autoLanguage: first.onlineSubtitles.autoLanguage });
        if (initialStart === null && first.resumePosition > 0)
          setResumeNotice(first.resumePosition);
      } catch (failure) {
        if (!cancelled) setError(errorMessage(failure));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [createSession, loadStream, searchOnline, initialStart]);

  // -------------------------------------------------------------------------
  // Progression de visionnage
  // -------------------------------------------------------------------------

  const saveProgress = useCallback((position = timeRef.current) => {
    const current = sessionRef.current;
    if (!current || position <= 0) return;
    void api(`/playback/sessions/${current.sessionId}/progress`, {
      method: 'POST',
      body: { position, duration: current.duration },
      keepalive: true,
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (video.current && !video.current.paused) saveProgress();
    }, 10_000);
    const onHide = () => saveProgress();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pagehide', onHide);
      saveProgress();
      const current = sessionRef.current;
      if (current && current.mode !== 'direct') {
        void api(`/playback/sessions/${current.sessionId}`, {
          method: 'DELETE',
          keepalive: true,
        }).catch(() => undefined);
      }
    };
  }, [saveProgress]);

  // -------------------------------------------------------------------------
  // Commandes
  // -------------------------------------------------------------------------

  const seek = useCallback(
    (target: number) => {
      const current = sessionRef.current;
      const element = video.current;
      if (!current || !element) return;
      const clamped = Math.max(
        0,
        current.duration ? Math.min(target, current.duration - 1) : target,
      );
      if (current.seek === 'native') {
        element.currentTime = clamped;
        return;
      }
      // Relance du flux (ffmpeg) : seule la dernière position d'une série d'appuis est chargée.
      if (seekTarget.current === null) seekFrom.current = timeRef.current;
      seekTarget.current = clamped;
      timeRef.current = clamped;
      setTime(clamped);
      window.clearTimeout(seekTimer.current);
      seekTimer.current = window.setTimeout(() => {
        const position = seekTarget.current;
        if (sessionRef.current !== current || position === null) return;
        const from = seekFrom.current;
        loadStream(current, position, position > from ? from : null);
      }, SEEK_DEBOUNCE_MS);
    },
    [loadStream],
  );

  useEffect(
    () => () => {
      window.clearTimeout(seekTimer.current);
      originRequest.current?.abort();
    },
    [],
  );

  const togglePlay = useCallback(() => {
    const element = video.current;
    if (!element) return;
    if (element.paused) void element.play().catch(() => undefined);
    else element.pause();
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void container.current?.requestFullscreen().catch(() => undefined);
  }, []);

  const changeAudio = useCallback(
    async (index: number) => {
      const position = timeRef.current;
      try {
        await activate(Math.max(level, 0) as FallbackLevel, index, position);
      } catch (failure) {
        toast.error('Changement de piste impossible', { description: errorMessage(failure) });
      }
    },
    [activate, level],
  );

  const goNext = useCallback(() => {
    const next = sessionRef.current?.next;
    if (!next) return;
    saveProgress();
    navigate(playerUrl(next.media), { replace: true });
  }, [navigate, saveProgress]);

  useEffect(() => {
    const element = video.current;
    if (element) {
      element.volume = volume;
      element.muted = muted;
    }
    store('lumiere.volume', String(volume));
    store('lumiere.muted', muted ? '1' : '0');
  }, [volume, muted, src]);

  // -------------------------------------------------------------------------
  // Sous-titres
  // -------------------------------------------------------------------------

  const cues = useMemo(
    () => (subtitleId ? (loadedCues[subtitleId] ?? []) : []),
    [subtitleId, loadedCues],
  );
  const subtitleLoaded = subtitleId !== null && subtitleId in loadedCues;

  useEffect(() => {
    if (!subtitleId || !session || subtitleLoaded) return;
    let cancelled = false;
    const toastId = toast.loading('Chargement des sous-titres…');
    fetch(`/api/playback/sessions/${session.sessionId}/subtitles/${encodeURIComponent(subtitleId)}`)
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            ((await response.json().catch(() => null)) as { message?: string } | null)?.message ??
              `Erreur ${response.status}`,
          );
        return response.text();
      })
      .then((text) => {
        const parsed = parseVtt(text);
        setLoadedCues((previous) => ({ ...previous, [subtitleId]: parsed }));
        toast.dismiss(toastId);
      })
      .catch((failure: unknown) => {
        toast.error('Sous-titres indisponibles', {
          id: toastId,
          description: errorMessage(failure),
        });
        if (!cancelled) setSubtitleId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [subtitleId, session, subtitleLoaded]);

  const visibleCues = useMemo(
    () => activeCues(cues, time - subtitleDelay),
    [cues, time, subtitleDelay],
  );

  const shiftSubtitles = useCallback(
    (step: number) => {
      const next = Math.round((subtitleDelay + step) * 100) / 100;
      setSubtitleDelay(next);
      showOsd(
        `Sous-titres : ${formatDelay(next)}`,
        next > 0 ? 'affichés plus tard' : next < 0 ? 'affichés plus tôt' : 'sans décalage',
      );
    },
    [subtitleDelay, showOsd],
  );

  useEffect(() => {
    if (!osd) return;
    const timer = window.setTimeout(() => setOsd(null), osd.durationMs);
    return () => window.clearTimeout(timer);
  }, [osd]);

  const selectSubtitle = useCallback(
    (value: string | null) => {
      if (value === SEARCH_ONLINE_AGAIN) {
        const current = sessionRef.current;
        if (current) void searchOnline(current, { force: true });
        return;
      }
      if (value?.startsWith(MENU_NOTE)) return;
      subtitlePicked.current = true;
      setSubtitleId(value);
      setSubtitleDelay(0);
    },
    [searchOnline],
  );

  const onSubtitleMenuOpenChange = useCallback(
    (open: boolean) => {
      onMenuOpenChange(open);
      const current = sessionRef.current;
      // Première ouverture du menu : recherche en ligne (une fois par lecture).
      if (open && current && !onlineSearched.current) void searchOnline(current);
    },
    [onMenuOpenChange, searchOnline],
  );

  // -------------------------------------------------------------------------
  // Interface : masquage automatique, clavier, plein écran
  // -------------------------------------------------------------------------

  const revealControls = useCallback(() => {
    setControls(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (video.current && !video.current.paused && !menuOpen.current) setControls(false);
    }, 3000);
  }, []);

  useEffect(() => {
    const onFullscreen = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => document.removeEventListener('fullscreenchange', onFullscreen);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      const step = event.shiftKey ? 30 : 10;
      switch (event.key) {
        case ' ':
        case 'k':
          event.preventDefault();
          togglePlay();
          break;
        case 'ArrowRight':
          event.preventDefault();
          seek(timeRef.current + step);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          seek(timeRef.current - step);
          break;
        case 'ArrowUp':
          event.preventDefault();
          setVolume((value) => Math.min(1, value + 0.1));
          setMuted(false);
          break;
        case 'ArrowDown':
          event.preventDefault();
          setVolume((value) => Math.max(0, value - 0.1));
          break;
        case 'm':
          setMuted((value) => !value);
          break;
        case 'f':
          toggleFullscreen();
          break;
        case 'n':
          goNext();
          break;
        case 'g':
          shiftSubtitles(-SUBTITLE_DELAY_STEP);
          break;
        case 'h':
          shiftSubtitles(SUBTITLE_DELAY_STEP);
          break;
        case 'Escape':
          if (!document.fullscreenElement) navigate(-1);
          break;
        default:
          return;
      }
      revealControls();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seek, toggleFullscreen, goNext, navigate, revealControls, shiftSubtitles]);

  useEffect(() => {
    if (resumeNotice === null) return;
    const timer = window.setTimeout(() => setResumeNotice(null), 9000);
    return () => window.clearTimeout(timer);
  }, [resumeNotice]);

  // Compte à rebours vers l'épisode suivant en fin de lecture.
  useEffect(() => {
    if (nextCountdown === null) return;
    if (nextCountdown <= 0) {
      goNext();
      return;
    }
    const timer = window.setTimeout(
      () => setNextCountdown((value) => (value === null ? null : value - 1)),
      1000,
    );
    return () => window.clearTimeout(timer);
  }, [nextCountdown, goNext]);

  // -------------------------------------------------------------------------
  // Événements de l'élément <video>
  // -------------------------------------------------------------------------

  /** L'élément <video> lit-il le dernier flux demandé (et non un flux remplacé) ? */
  const isCurrent = (element: HTMLVideoElement) =>
    streamId.current === null || element.currentSrc.includes(`stream=${streamId.current}`);

  const onTimeUpdate = () => {
    const element = video.current;
    // Positionnement en attente, ou ancien flux : la position affichée reste celle visée.
    if (!element || seekTarget.current !== null || !isCurrent(element)) return;
    const absolute = offset + element.currentTime;
    timeRef.current = absolute;
    setTime(absolute);
    if (element.buffered.length > 0)
      setBufferedEnd(offset + element.buffered.end(element.buffered.length - 1));
  };

  const onLoadedMetadata = () => {
    const element = video.current;
    if (!element) return;
    const current = sessionRef.current;
    // Lecture directe d'une vidéo dont le codec n'est finalement pas décodé : repli.
    if (current?.mode === 'direct' && current.video && element.videoWidth === 0) {
      void fallback('codec vidéo non décodé');
      return;
    }
    if (pendingSeek.current !== null) {
      element.currentTime = pendingSeek.current;
      pendingSeek.current = null;
    }
    void element.play().catch(() => setBuffering(false));
  };

  const fallback = async (reason: string) => {
    const current = sessionRef.current;
    if (!current) return;
    const nextLevel: FallbackLevel | null = current.mode === 'direct' ? 1 : level < 2 ? 2 : null;
    if (nextLevel === null) {
      setError(streamFailure.current ?? `Lecture impossible (${reason}).`);
      return;
    }
    toast.info(
      nextLevel === 1
        ? 'Lecture directe impossible : remultiplexage…'
        : 'Conversion vidéo en cours de démarrage…',
    );
    try {
      await activate(nextLevel, current.selectedAudioTrack, timeRef.current);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  /** Relance le flux là où il s'est interrompu ; false quand les reprises récentes sont épuisées. */
  const recover = () => {
    const current = sessionRef.current;
    if (!current) return false;
    const now = Date.now();
    recoveries.current = recoveries.current.filter((at) => now - at < RECOVERY_WINDOW_MS);
    if (recoveries.current.length >= MAX_RECOVERIES) return false;
    recoveries.current.push(now);
    setBuffering(true);
    toast.info('Lecture interrompue : reprise…', { id: 'player-recovery' });
    window.setTimeout(() => {
      if (sessionRef.current === current) loadStream(current, timeRef.current);
    }, 1000 * recoveries.current.length);
    return true;
  };

  const onVideoError = () => {
    const element = video.current;
    const mediaError = element?.error;
    if (!src || !element || !mediaError || !isCurrent(element)) return;
    // Flux déjà lu : coupure (réseau, source, positionnement), on reprend au même endroit
    // plutôt que de basculer vers une conversion plus lourde.
    if (hasPlayed.current && recover()) return;
    void fallback(mediaError.message || `erreur ${mediaError.code}`);
  };

  const onEnded = () => {
    setPlaying(false);
    if (duration) saveProgress(duration);
    if (session?.next) setNextCountdown(8);
  };

  // -------------------------------------------------------------------------
  // Rendu
  // -------------------------------------------------------------------------

  if (error)
    return (
      <PlayerFailure
        message={error}
        onBack={() => navigate(-1)}
        onRetry={() => window.location.reload()}
      />
    );

  const remaining = duration ? duration - time : null;
  const showNextCard =
    session?.next &&
    (nextCountdown !== null || (remaining !== null && remaining < 25 && remaining > 0));
  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const toOption = (track: SubtitleTrackInfo) => ({
    value: track.id as string | null,
    label: track.label,
    hint: subtitleHint(track),
    disabled: !track.supported,
  });
  const onlineAvailable = session?.onlineSubtitles.available ?? false;
  const subtitleOptions = [
    { value: null as string | null, label: 'Désactivés' },
    ...(session?.subtitleTracks ?? []).map(toOption),
    ...onlineTracks.map(toOption),
    ...(onlineAvailable && onlineStatus === 'searching'
      ? [{ value: `${MENU_NOTE}:searching`, label: 'Recherche en ligne…', disabled: true }]
      : []),
    ...(onlineAvailable && onlineStatus !== 'searching' && onlineNotices.length > 0
      ? [
          {
            value: `${MENU_NOTE}:notices`,
            label: 'Recherche en ligne incomplète',
            hint: onlineNotices.join(' · '),
            disabled: true,
          },
        ]
      : []),
    ...(onlineAvailable && onlineStatus === 'done' && onlineTracks.length === 0
      ? [{ value: `${MENU_NOTE}:none`, label: 'Aucun sous-titre trouvé en ligne', disabled: true }]
      : []),
    ...(onlineAvailable && (onlineStatus === 'done' || onlineStatus === 'error')
      ? [{ value: SEARCH_ONLINE_AGAIN, label: 'Relancer la recherche en ligne' }]
      : []),
  ];

  return (
    <div
      ref={container}
      className={cn(
        'fixed inset-0 z-50 bg-black text-white select-none',
        !controls && playing && 'cursor-none',
      )}
      onPointerMove={revealControls}
      onPointerDown={revealControls}
    >
      {src && (
        <video
          ref={video}
          src={src}
          className="absolute inset-0 size-full object-contain"
          playsInline
          autoPlay
          preload="auto"
          onClick={togglePlay}
          onDoubleClick={toggleFullscreen}
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={onTimeUpdate}
          onPlay={() => setPlaying(true)}
          onPause={() => {
            setPlaying(false);
            saveProgress();
            setControls(true);
          }}
          onWaiting={() => setBuffering(true)}
          onPlaying={() => {
            hasPlayed.current = true;
            setBuffering(false);
          }}
          onCanPlay={() => setBuffering(false)}
          onEnded={onEnded}
          onError={onVideoError}
        />
      )}

      {buffering && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="glass glass-clear flex size-20 items-center justify-center rounded-full">
            <Spinner className="size-9 text-white" />
          </span>
        </div>
      )}
      {!playing && !buffering && src && (
        <Button
          variant="glass-clear"
          size="icon-xl"
          onClick={togglePlay}
          aria-label="Lecture"
          className="absolute top-1/2 left-1/2 size-24 -translate-x-1/2 -translate-y-1/2"
        >
          <Play className="ml-1.5 size-10 fill-white" />
        </Button>
      )}

      {visibleCues.length > 0 && (
        <div
          className={cn(
            'pointer-events-none absolute inset-x-0 flex flex-col items-center gap-1 px-[8%] text-center transition-[bottom] duration-300',
            controls ? 'bottom-40' : 'bottom-12',
          )}
        >
          {visibleCues.map((cue, index) => (
            <p
              key={`${cue.start}-${index}`}
              className="subtitle-cue rounded-md bg-black/35 px-3 py-0.5 text-[clamp(1.05rem,2.5vw,2.4rem)] leading-snug font-semibold"
              dangerouslySetInnerHTML={{ __html: cue.html }}
            />
          ))}
        </div>
      )}

      <div
        className={cn(
          'transition-opacity duration-300',
          controls || !playing ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
        {/* Voiles d'atténuation : le verre clair reste lisible sur une image claire (HIG). */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-36 bg-gradient-to-b from-black/60 to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-56 bg-gradient-to-t from-black/70 via-black/30 to-transparent" />

        <div className="absolute inset-x-0 top-0 flex items-start gap-4 px-4 pt-4 sm:px-6 sm:pt-5">
          <Button
            variant="glass-clear"
            size="icon-lg"
            onClick={() => navigate(-1)}
            aria-label="Retour"
          >
            <ArrowLeft className="size-5" />
          </Button>
          <div className="text-shadow-legible min-w-0 flex-1 pt-1">
            <h1 className="truncate text-lg font-bold tracking-tight sm:text-xl">
              {session?.title ?? 'Chargement…'}
            </h1>
            {session?.subtitle && (
              <p className="truncate text-sm text-zinc-200">{session.subtitle}</p>
            )}
          </div>
          {session && (
            <span
              title={session.reasons.join('\n')}
              className="glass glass-clear mt-1.5 hidden rounded-full px-3 py-1.5 text-xs font-semibold text-zinc-100 sm:block"
            >
              {MODE_LABELS[session.mode]}
              {session.video?.height ? ` · ${session.video.height}p` : ''}
              {session.video?.hdr ? ' · HDR' : ''}
            </span>
          )}
        </div>

        {/*
          Panneau de commandes flottant (comme le lecteur de tvOS 26). Verre normal et non
          « clair » : il porte du texte (temps, épisode suivant) qui doit rester lisible même
          sur une image très claire.
        */}
        <Glass
          lens={{ bezel: 20, strength: 16 }}
          className="absolute inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] rounded-panel px-4 pt-2.5 pb-2 sm:inset-x-6 sm:bottom-6 sm:px-5"
        >
          <ProgressSlider current={time} duration={duration} buffered={bufferedEnd} onSeek={seek} />
          <div className="mt-0.5 flex items-center gap-0.5 sm:gap-1">
            <PlayerIcon onClick={togglePlay} label={playing ? 'Pause' : 'Lecture'}>
              {playing ? (
                <Pause className="size-6 fill-white" />
              ) : (
                <Play className="size-6 fill-white" />
              )}
            </PlayerIcon>
            <PlayerIcon onClick={() => seek(timeRef.current - 10)} label="Reculer de 10 secondes">
              <RotateCcw className="size-5" />
            </PlayerIcon>
            <PlayerIcon onClick={() => seek(timeRef.current + 10)} label="Avancer de 10 secondes">
              <RotateCw className="size-5" />
            </PlayerIcon>
            {/* Sur mobile, le volume se règle avec les boutons de l'appareil. */}
            <div className="group/volume hidden items-center sm:flex">
              <PlayerIcon onClick={() => setMuted((value) => !value)} label="Couper le son">
                <VolumeIcon className="size-5" />
              </PlayerIcon>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={(event) => {
                  setVolume(Number(event.target.value));
                  setMuted(false);
                }}
                className="w-0 accent-brand-400 opacity-0 transition-all group-hover/volume:w-24 group-hover/volume:opacity-100 focus:w-24 focus:opacity-100"
                aria-label="Volume"
              />
            </div>
            <span className="ml-1.5 text-sm font-medium whitespace-nowrap text-zinc-100 tabular-nums">
              {formatClock(time)}{' '}
              <span className="text-zinc-400">/ {duration ? formatClock(duration) : '--:--'}</span>
            </span>
            <div className="flex-1" />
            {session?.next && (
              <button
                type="button"
                onClick={goNext}
                className="hidden h-10 items-center gap-2 rounded-full px-3.5 text-sm font-medium transition hover:bg-white/[0.14] sm:flex"
                title="Épisode suivant (N)"
              >
                <SkipForward className="size-5" />
                {session.next.label}
              </button>
            )}
            {session && session.audioTracks.length > 1 && (
              <TrackMenu
                icon={<AudioLines className="size-5" />}
                title="Piste audio"
                label="Audio"
                value={session.selectedAudioTrack}
                options={session.audioTracks.map((track) => ({
                  value: track.index as number | null,
                  label: track.label,
                }))}
                onOpenChange={onMenuOpenChange}
                onSelect={(value) => {
                  if (value !== null && value !== session.selectedAudioTrack)
                    void changeAudio(value);
                }}
              />
            )}
            {session && (
              <TrackMenu
                icon={<Captions className={cn('size-5', subtitleId && 'text-brand-300')} />}
                title="Sous-titres (G / H : décalage)"
                label={
                  subtitleDelay === 0
                    ? 'Sous-titres'
                    : `Sous-titres · décalage ${formatDelay(subtitleDelay)}`
                }
                value={subtitleId}
                options={subtitleOptions}
                onOpenChange={onSubtitleMenuOpenChange}
                onSelect={selectSubtitle}
              />
            )}
            <PlayerIcon onClick={toggleFullscreen} label="Plein écran">
              {fullscreen ? <Minimize className="size-5" /> : <Maximize className="size-5" />}
            </PlayerIcon>
          </div>
        </Glass>
      </div>

      {osd && (
        <div className="pointer-events-none absolute inset-x-0 top-20 flex justify-center px-4">
          <Glass
            key={osd.at}
            variant="thick"
            className="flex max-w-xl animate-materialize flex-col items-center rounded-card px-4 py-2 text-center"
          >
            <span className="text-sm font-semibold">{osd.text}</span>
            {osd.detail && <span className="text-xs text-zinc-300">{osd.detail}</span>}
          </Glass>
        </div>
      )}

      {resumeNotice !== null && (
        <Glass
          variant="thick"
          className="absolute bottom-36 left-4 flex animate-materialize items-center gap-3 rounded-full py-1.5 pr-1.5 pl-4 text-sm sm:left-6"
        >
          <span>Reprise à {formatClock(resumeNotice)}</span>
          <Button
            size="sm"
            variant="secondary"
            icon={<RotateCcw className="size-3.5" />}
            onClick={() => {
              setResumeNotice(null);
              seek(0);
            }}
          >
            Depuis le début
          </Button>
        </Glass>
      )}

      {showNextCard && session?.next && (
        <Glass
          variant="thick"
          className="absolute right-4 bottom-36 w-72 animate-materialize rounded-card p-4 sm:right-6"
        >
          <p className="text-xs font-semibold text-zinc-300">Épisode suivant</p>
          <p className="mt-0.5 font-semibold">{session.next.label}</p>
          <div className="mt-3 flex gap-2">
            <Button
              variant="primary"
              size="sm"
              icon={<SkipForward className="size-4" />}
              onClick={goNext}
            >
              {nextCountdown !== null ? `Lecture dans ${nextCountdown} s` : 'Lancer'}
            </Button>
            {nextCountdown !== null && (
              <Button variant="ghost" size="sm" onClick={() => setNextCountdown(null)}>
                Annuler
              </Button>
            )}
          </div>
        </Glass>
      )}
    </div>
  );
}

/** Bouton d'icône du panneau de commandes (sans verre : il repose déjà sur le verre). */
function PlayerIcon({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-10 shrink-0 items-center justify-center rounded-full transition hover:bg-white/[0.14] active:scale-95"
    >
      {children}
    </button>
  );
}

function PlayerFailure({
  message,
  onBack,
  onRetry,
}: {
  message: string;
  onBack?: () => void;
  onRetry?: () => void;
}) {
  const navigate = useNavigate();
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-ink-950 px-6 text-center">
      <p className="text-xl font-bold">Lecture impossible</p>
      <p className="max-w-lg text-sm text-zinc-300">{message}</p>
      <div className="flex gap-2">
        <Button
          variant="glass"
          icon={<ArrowLeft className="size-4" />}
          onClick={onBack ?? (() => navigate('/'))}
        >
          Retour
        </Button>
        {onRetry && (
          <Button variant="primary" onClick={onRetry}>
            Réessayer
          </Button>
        )}
      </div>
    </div>
  );
}
