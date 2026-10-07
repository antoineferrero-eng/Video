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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import type { MediaRef, PlaybackSession } from '@lumiere/shared';
import { api, errorMessage } from '../../api/client';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { detectCapabilities } from '../../lib/capabilities';
import { cn } from '../../lib/cn';
import { formatClock } from '../../lib/format';
import { mediaFromSearch, playerUrl } from '../../lib/routes';
import { activeCues, parseVtt, type Cue } from '../../lib/vtt';
import { ProgressSlider } from './ProgressSlider';
import { TrackMenu } from './TrackMenu';

/** 0 = automatique, 1 = lecture directe désactivée (remultiplexage), 2 = conversion forcée. */
type FallbackLevel = 0 | 1 | 2;

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
  const [nextCountdown, setNextCountdown] = useState<number | null>(null);
  const [resumeNotice, setResumeNotice] = useState<number | null>(null);

  const pendingSeek = useRef<number | null>(null);
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

  /** Charge le flux d'une session à une position donnée (seek natif ou relance du flux). */
  const loadStream = useCallback(async (target: PlaybackSession, position: number) => {
    setBuffering(true);
    if (target.seek === 'native') {
      pendingSeek.current = position > 0 ? position : null;
      setOffset(0);
      setSrc(target.streamUrl);
      return;
    }
    let startAt = 0;
    if (position > 0) {
      const resolved = await api<{ start: number }>(`/playback/sessions/${target.sessionId}/seek`, {
        query: { position },
      });
      startAt = resolved.start;
    }
    pendingSeek.current = null;
    setOffset(startAt);
    timeRef.current = startAt;
    setTime(startAt);
    setSrc(`${target.streamUrl}?start=${startAt.toFixed(3)}&n=${Date.now()}`);
  }, []);

  const activate = useCallback(
    async (fallback: FallbackLevel, audioTrack: number | null, position: number) => {
      const next = await createSession(fallback, audioTrack);
      sessionRef.current = next;
      setSession(next);
      setLevel(fallback);
      await loadStream(next, position);
      return next;
    },
    [createSession, loadStream],
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
        await loadStream(first, position);
        if (initialStart === null && first.resumePosition > 0)
          setResumeNotice(first.resumePosition);
      } catch (failure) {
        if (!cancelled) setError(errorMessage(failure));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [createSession, loadStream, initialStart]);

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
    async (target: number) => {
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
      timeRef.current = clamped;
      setTime(clamped);
      try {
        await loadStream(current, clamped);
      } catch (failure) {
        toast.error('Positionnement impossible', { description: errorMessage(failure) });
      }
    },
    [loadStream],
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

  const visibleCues = useMemo(() => activeCues(cues, time), [cues, time]);

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
          void seek(timeRef.current + step);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          void seek(timeRef.current - step);
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
  }, [togglePlay, seek, toggleFullscreen, goNext, navigate, revealControls]);

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

  const onTimeUpdate = () => {
    const element = video.current;
    if (!element) return;
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
      setError(`Lecture impossible (${reason}).`);
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

  const onVideoError = () => {
    const mediaError = video.current?.error;
    if (!src || !mediaError) return;
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
  const subtitleOptions = [
    { value: null as string | null, label: 'Désactivés' },
    ...(session?.subtitleTracks ?? []).map((track) => ({
      value: track.id as string | null,
      label: track.label,
      hint: `${track.source === 'embedded' ? 'Intégrés' : 'Fichier externe'} · ${track.codec.toUpperCase()}${track.supported ? '' : ' (format image non pris en charge)'}`,
      disabled: !track.supported,
    })),
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
          onPlaying={() => setBuffering(false)}
          onCanPlay={() => setBuffering(false)}
          onEnded={onEnded}
          onError={onVideoError}
        />
      )}

      {buffering && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Spinner className="size-12 text-brand-300" />
        </div>
      )}
      {!playing && !buffering && src && (
        <button
          type="button"
          onClick={togglePlay}
          aria-label="Lecture"
          className="absolute top-1/2 left-1/2 flex size-20 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 backdrop-blur-md transition hover:scale-105 hover:bg-white/25"
        >
          <Play className="ml-1 size-9 fill-white" />
        </button>
      )}

      {visibleCues.length > 0 && (
        <div
          className={cn(
            'pointer-events-none absolute inset-x-0 flex flex-col items-center gap-1 px-[8%] text-center transition-[bottom] duration-300',
            controls ? 'bottom-32' : 'bottom-12',
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
        <div className="absolute inset-x-0 top-0 flex items-start gap-4 bg-gradient-to-b from-black/80 to-transparent px-4 pt-4 pb-16 sm:px-8">
          <Button variant="glass" size="icon" onClick={() => navigate(-1)} aria-label="Retour">
            <ArrowLeft className="size-5" />
          </Button>
          <div className="min-w-0 flex-1 pt-0.5">
            <h1 className="truncate text-lg font-semibold sm:text-xl">
              {session?.title ?? 'Chargement…'}
            </h1>
            {session?.subtitle && (
              <p className="truncate text-sm text-zinc-300">{session.subtitle}</p>
            )}
          </div>
          {session && (
            <span
              title={session.reasons.join('\n')}
              className="hidden rounded-lg bg-white/10 px-2.5 py-1 text-xs font-medium text-zinc-200 backdrop-blur sm:block"
            >
              {MODE_LABELS[session.mode]}
              {session.video?.height ? ` · ${session.video.height}p` : ''}
              {session.video?.hdr ? ' · HDR' : ''}
            </span>
          )}
        </div>

        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-4 pt-16 pb-4 sm:px-8 sm:pb-6">
          <ProgressSlider
            current={time}
            duration={duration}
            buffered={bufferedEnd}
            onSeek={(value) => void seek(value)}
          />
          <div className="mt-2 flex items-center gap-1 sm:gap-2">
            <button
              type="button"
              onClick={togglePlay}
              className="rounded-lg p-2 transition hover:bg-white/10"
              aria-label={playing ? 'Pause' : 'Lecture'}
            >
              {playing ? (
                <Pause className="size-6 fill-white" />
              ) : (
                <Play className="size-6 fill-white" />
              )}
            </button>
            <button
              type="button"
              onClick={() => void seek(time - 10)}
              className="rounded-lg p-2 transition hover:bg-white/10"
              aria-label="Reculer de 10 secondes"
            >
              <RotateCcw className="size-5" />
            </button>
            <button
              type="button"
              onClick={() => void seek(time + 10)}
              className="rounded-lg p-2 transition hover:bg-white/10"
              aria-label="Avancer de 10 secondes"
            >
              <RotateCw className="size-5" />
            </button>
            <div className="group/volume flex items-center">
              <button
                type="button"
                onClick={() => setMuted((value) => !value)}
                className="rounded-lg p-2 transition hover:bg-white/10"
                aria-label="Couper le son"
              >
                <VolumeIcon className="size-5" />
              </button>
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
            <span className="ml-1 text-sm text-zinc-300 tabular-nums">
              {formatClock(time)}{' '}
              <span className="text-zinc-500">/ {duration ? formatClock(duration) : '--:--'}</span>
            </span>
            <div className="flex-1" />
            {session?.next && (
              <button
                type="button"
                onClick={goNext}
                className="hidden items-center gap-2 rounded-lg px-3 py-2 text-sm transition hover:bg-white/10 sm:flex"
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
                title="Sous-titres"
                label="Sous-titres"
                value={subtitleId}
                options={subtitleOptions}
                onOpenChange={onMenuOpenChange}
                onSelect={setSubtitleId}
              />
            )}
            <button
              type="button"
              onClick={toggleFullscreen}
              className="rounded-lg p-2 transition hover:bg-white/10"
              aria-label="Plein écran"
            >
              {fullscreen ? <Minimize className="size-5" /> : <Maximize className="size-5" />}
            </button>
          </div>
        </div>
      </div>

      {resumeNotice !== null && (
        <div className="absolute bottom-28 left-4 flex animate-fade-in items-center gap-3 rounded-2xl border border-white/10 bg-ink-900/90 py-2 pr-2 pl-4 text-sm shadow-2xl backdrop-blur-xl sm:left-8">
          <span>Reprise à {formatClock(resumeNotice)}</span>
          <Button
            size="sm"
            variant="secondary"
            icon={<RotateCcw className="size-3.5" />}
            onClick={() => {
              setResumeNotice(null);
              void seek(0);
            }}
          >
            Depuis le début
          </Button>
        </div>
      )}

      {showNextCard && session?.next && (
        <div className="absolute right-4 bottom-28 animate-fade-in rounded-2xl border border-white/10 bg-ink-900/90 p-4 shadow-2xl backdrop-blur-xl sm:right-8">
          <p className="text-xs tracking-wide text-zinc-400 uppercase">Épisode suivant</p>
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
        </div>
      )}
    </div>
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
      <p className="text-xl font-semibold">Lecture impossible</p>
      <p className="max-w-lg text-sm text-zinc-400">{message}</p>
      <div className="flex gap-2">
        <Button icon={<ArrowLeft className="size-4" />} onClick={onBack ?? (() => navigate('/'))}>
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
