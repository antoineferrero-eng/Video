/** Référence vers un média lisible : fichier distant ou élément de la bibliothèque locale. */
export type MediaRef =
  | { type: 'remote'; path: string }
  | { type: 'library'; id: number }
  /** Épisode dont le fichier est choisi au moment de la lecture (extension Stremio). */
  | { type: 'episode'; titleId: number; season: number; episode: number };

/** Codecs et conteneurs que le navigateur sait décoder nativement. */
export interface ClientCapabilities {
  videoCodecs: string[];
  audioCodecs: string[];
  containers: string[];
}

export interface PlaybackRequest {
  media: MediaRef;
  capabilities: ClientCapabilities;
  /** Index (relatif aux pistes audio) de la piste souhaitée. */
  audioTrack?: number | null;
  /** `transcode` force la conversion (repli en cas d'échec de lecture directe). */
  mode?: 'auto' | 'transcode';
}

/**
 * - `direct` : le fichier est servi tel quel (seek natif via HTTP Range).
 * - `remux` : la vidéo est copiée, seul le conteneur et/ou l'audio sont convertis.
 * - `transcode` : la vidéo est réencodée.
 */
export type PlaybackMode = 'direct' | 'remux' | 'transcode';

export interface AudioTrackInfo {
  index: number;
  label: string;
  language: string | null;
  codec: string;
  channels: number | null;
  isDefault: boolean;
}

/**
 * - `embedded` : piste intégrée au fichier vidéo ;
 * - `external` : fichier rangé à côté de la vidéo (.srt, .vtt, .ass) ;
 * - `online` : trouvé en ligne (OpenSubtitles, extension Stremio de sous-titres).
 */
export type SubtitleSourceKind = 'embedded' | 'external' | 'online';

export interface SubtitleTrackInfo {
  id: string;
  label: string;
  language: string | null;
  codec: string;
  source: SubtitleSourceKind;
  supported: boolean;
  isDefault: boolean;
  isForced: boolean;
  /** Sous-titres en ligne : service qui les propose (« OpenSubtitles »…). */
  provider?: string;
  /** Sous-titres en ligne : faits pour ce fichier précis (empreinte OpenSubtitles identique). */
  hashMatch?: boolean;
  hearingImpaired?: boolean;
  /** Sous-titres en ligne : version (release) pour laquelle ils ont été faits. */
  release?: string | null;
  downloads?: number | null;
}

/**
 * Recalage d'une piste de sous-titres : instant d'affichage = rate × instant prévu + offset
 * (en secondes). Gardé par fichier et par piste.
 */
export interface SubtitleSync {
  offset: number;
  /** Vitesse : 1, ou le rapport de deux cadences (25 / 23,976…). */
  rate: number;
  source: 'manual' | 'auto';
  /** Recalage automatique : sur quoi il s'est calé (« la voix », « la piste intégrée anglaise »…). */
  note: string | null;
}

export interface SubtitleSyncState {
  sync: SubtitleSync | null;
  /** Recalage automatique déjà essayé sans résultat sûr (ne pas le relancer d'office). */
  autoFailed: boolean;
}

export interface SubtitleSyncResult {
  /** Recalage trouvé et enregistré ; null si rien de sûr. */
  sync: SubtitleSync | null;
  message: string;
}

/** Résultat d'une recherche de sous-titres en ligne pour une session de lecture. */
export interface OnlineSubtitlesResult {
  tracks: SubtitleTrackInfo[];
  /** Services interrogés. */
  providers: string[];
  /** Problèmes rencontrés (service injoignable, clé refusée…). */
  notices: string[];
}

export interface PlaybackSession {
  sessionId: string;
  mode: PlaybackMode;
  /**
   * URL du flux ; pour les modes `remux`/`transcode`, ajouter `?start=<secondes>&stream=<id>`
   * pour se positionner, puis lire l'instant réel de départ sur `…/streams/<id>/origin`.
   */
  streamUrl: string;
  mimeType: string;
  seek: 'native' | 'restart';
  duration: number | null;
  resumePosition: number;
  mediaKey: string;
  title: string;
  subtitle: string | null;
  titleId: number | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  audioTracks: AudioTrackInfo[];
  selectedAudioTrack: number | null;
  subtitleTracks: SubtitleTrackInfo[];
  defaultSubtitleTrack: string | null;
  video: { codec: string | null; width: number | null; height: number | null; hdr: boolean } | null;
  reasons: string[];
  next: { media: MediaRef; label: string } | null;
  /** Recherche de sous-titres en ligne. */
  onlineSubtitles: {
    /** Au moins un service de sous-titres en ligne est configuré. */
    available: boolean;
    /**
     * Langue de sous-titres préférée absente du fichier : la recherche est lancée d'office et
     * le meilleur résultat dans cette langue est choisi.
     */
    autoLanguage: string | null;
  };
}

export interface ProgressUpdate {
  position: number;
  duration: number | null;
}

export interface ContinueWatchingItem {
  mediaKey: string;
  media: MediaRef;
  title: string;
  subtitle: string | null;
  titleId: number | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  position: number;
  duration: number | null;
  updatedAt: string;
}
