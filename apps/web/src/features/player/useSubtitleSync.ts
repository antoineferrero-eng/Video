import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type {
  SubtitleSync,
  SubtitleSyncResult,
  SubtitleSyncState,
  SubtitleTrackInfo,
} from '@lumiere/shared';
import { api, errorMessage } from '../../api/client';
import type { Cue } from '../../lib/vtt';
import { PLAYER_TOAST } from './player-toast';
import {
  NO_SYNC,
  anchorCue,
  describeSync,
  isIdentity,
  syncFromAnchors,
  type Anchor,
  type SyncValue,
} from './subtitle-sync';

/** Délai avant d'enregistrer un réglage manuel (appuis répétés regroupés). */
const SAVE_DELAY_MS = 800;

/** Sous-titres qui ne sont pas faits pour ce fichier précis : recalés d'office. */
function needsAutoSync(track: SubtitleTrackInfo): boolean {
  return track.source === 'external' || (track.source === 'online' && !track.hashMatch);
}

/**
 * Recalage de la piste de sous-titres affichée : réglage gardé par fichier et par piste,
 * recalage automatique des sous-titres trouvés en ligne, décalage (G / H) et répliques
 * calées sur ce que l'on entend (Maj+G : la suivante, Maj+H : la précédente).
 */
export function useSubtitleSync({
  sessionId,
  track,
  cues,
  timeRef,
  showOsd,
}: {
  sessionId: string | null;
  track: SubtitleTrackInfo | null;
  cues: Cue[];
  timeRef: { current: number };
  showOsd: (text: string, detail?: string, durationMs?: number) => void;
}) {
  const trackId = track?.id ?? null;
  const ready = cues.length > 0;
  const url =
    sessionId && trackId
      ? `/playback/sessions/${sessionId}/subtitles/${encodeURIComponent(trackId)}/sync`
      : null;
  // Recalage rattaché à la piste (et à la session) à laquelle il s'applique : il retombe à
  // zéro de lui-même quand on en change.
  const [state, setState] = useState<{ url: string | null; sync: SyncValue; note: string | null }>({
    url: null,
    sync: NO_SYNC,
    note: null,
  });
  const current = state.url === url;
  const sync = current ? state.sync : NO_SYNC;
  const note = current ? state.note : null;
  const [syncing, setSyncing] = useState(false);
  const anchors = useRef<Anchor[]>([]);
  /** Réglé à la main depuis le choix de la piste : un recalage automatique ne l'écrase pas. */
  const touched = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);
  /** Piste affichée : une réponse arrivée après un changement de piste est ignorée. */
  const latest = useRef(url);
  useEffect(() => {
    latest.current = url;
  }, [url]);

  const apply = useCallback(
    (value: SubtitleSync | SyncValue | null, label: string | null) =>
      setState({
        url,
        sync: value ? { offset: value.offset, rate: value.rate } : NO_SYNC,
        note: label,
      }),
    [url],
  );

  const runAuto = useCallback(
    async (manual: boolean) => {
      if (!url) return;
      setSyncing(true);
      const toastId = manual
        ? toast.loading('Synchronisation des sous-titres…', PLAYER_TOAST)
        : undefined;
      try {
        const result = await api<SubtitleSyncResult>(`${url}/auto`, { method: 'POST' });
        if (latest.current !== url) {
          if (toastId !== undefined) toast.dismiss(toastId);
          return;
        }
        if (result.sync && (manual || !touched.current)) {
          anchors.current = [];
          apply(result.sync, result.sync.note);
          const changed = !isIdentity(result.sync);
          if (changed || manual) {
            toast.success(result.message, {
              ...PLAYER_TOAST,
              id: toastId,
              duration: 8000,
              action: changed
                ? {
                    label: 'Annuler',
                    onClick: () => {
                      apply(NO_SYNC, null);
                      void api(url, { method: 'DELETE' }).catch(() => undefined);
                    },
                  }
                : undefined,
            });
          }
        } else if (!result.sync && manual) {
          toast.message(result.message, { ...PLAYER_TOAST, id: toastId, duration: 8000 });
        } else if (toastId !== undefined) {
          toast.dismiss(toastId);
        }
      } catch (failure) {
        if (manual)
          toast.error('Synchronisation impossible', {
            ...PLAYER_TOAST,
            id: toastId,
            description: errorMessage(failure),
          });
      } finally {
        setSyncing(false);
      }
    },
    [url, apply],
  );

  // Piste choisie : réglage gardé, sinon recalage automatique si elle n'est pas faite pour
  // ce fichier.
  useEffect(() => {
    anchors.current = [];
    touched.current = false;
    window.clearTimeout(saveTimer.current);
    if (!url || !track || !ready) return;
    let cancelled = false;
    api<SubtitleSyncState>(url)
      .then((state) => {
        if (cancelled || touched.current) return;
        if (state.sync) {
          apply(state.sync, state.sync.note);
          if (!isIdentity(state.sync))
            showOsd(
              `Sous-titres recalés : ${describeSync(state.sync)}`,
              state.sync.source === 'manual'
                ? 'réglage gardé pour ce fichier'
                : (state.sync.note ?? undefined),
            );
        } else if (!state.autoFailed && needsAutoSync(track)) {
          void runAuto(false);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // La piste (par son identifiant) et ses répliques chargées déclenchent le chargement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ready]);

  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  const save = useCallback(
    (value: SyncValue) => {
      if (!url) return;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        void api(url, { method: 'PUT', body: value }).catch(() => undefined);
      }, SAVE_DELAY_MS);
    },
    [url],
  );

  const change = useCallback(
    (value: SyncValue, detail: string) => {
      touched.current = true;
      apply(value, null);
      save(value);
      showOsd(`Sous-titres : ${describeSync(value)}`, detail);
    },
    [apply, save, showOsd],
  );

  /** G / H : sous-titres affichés plus tôt / plus tard. */
  const nudge = useCallback(
    (step: number) => {
      if (!trackId) return;
      const next = { ...sync, offset: Math.round((sync.offset + step) * 100) / 100 };
      change(next, next.offset > sync.offset ? 'affichés plus tard' : 'affichés plus tôt');
    },
    [sync, trackId, change],
  );

  /** Maj+G / Maj+H : la réplique suivante / précédente calée sur ce que l'on entend. */
  const anchor = useCallback(
    (which: 'next' | 'previous') => {
      if (!trackId) return;
      const time = timeRef.current;
      const cue = anchorCue(cues, time, sync, which);
      if (!cue) {
        showOsd(which === 'next' ? 'Aucune réplique à venir' : 'Aucune réplique affichée avant');
        return;
      }
      anchors.current = [...anchors.current, { cue: cue.start, media: time }].slice(-6);
      const next = syncFromAnchors(anchors.current, sync);
      change(
        next,
        next.rate !== sync.rate
          ? 'vitesse corrigée d’après deux répliques calées'
          : which === 'next'
            ? 'réplique suivante calée sur la voix'
            : 'réplique précédente calée sur la voix',
      );
    },
    [cues, sync, trackId, timeRef, change, showOsd],
  );

  const reset = useCallback(() => {
    anchors.current = [];
    touched.current = true;
    window.clearTimeout(saveTimer.current);
    apply(NO_SYNC, null);
    if (url) void api(url, { method: 'DELETE' }).catch(() => undefined);
    showOsd('Sous-titres : recalage annulé');
  }, [url, apply, showOsd]);

  return {
    sync,
    note,
    syncing,
    nudge,
    anchor,
    reset,
    autoSync: () => void runAuto(true),
  };
}
