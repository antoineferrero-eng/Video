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

export interface SubtitleTrackInfo {
  id: string;
  label: string;
  language: string | null;
  codec: string;
  source: 'embedded' | 'external';
  supported: boolean;
  isDefault: boolean;
  isForced: boolean;
}

export interface PlaybackSession {
  sessionId: string;
  mode: PlaybackMode;
  /** URL du flux ; pour les modes `remux`/`transcode`, ajouter `?start=<secondes>` pour se positionner. */
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
