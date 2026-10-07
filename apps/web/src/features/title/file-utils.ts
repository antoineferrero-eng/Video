import type { MediaRef, RemoteFile } from '@lumiere/shared';
import { useDownloads } from '../../api/queries';

/** Chemin « virtuel » d'un fichier fourni par l'extension Stremio (pas de dossier à parcourir). */
export function isAddonPath(path: string): boolean {
  return path.startsWith('/@stremio/');
}

export function mediaRefFor(file: RemoteFile): MediaRef {
  return file.availability.libraryItemId !== null
    ? { type: 'library', id: file.availability.libraryItemId }
    : { type: 'remote', path: file.path };
}

/** État de téléchargement « en direct » d'un fichier (fusion des détails et du flux temps réel). */
export function useLiveDownload(file: RemoteFile) {
  const downloads = useDownloads();
  const id = file.availability.download?.id;
  const live = id !== undefined ? downloads.data?.items.find((item) => item.id === id) : undefined;
  if (live) {
    return {
      id: live.id,
      status: live.status,
      progress: live.totalBytes ? live.downloadedBytes / live.totalBytes : null,
      libraryItemId: live.libraryItemId ?? file.availability.libraryItemId,
    };
  }
  const base = file.availability.download;
  return base
    ? {
        id: base.id,
        status: base.status,
        progress: base.progress,
        libraryItemId: file.availability.libraryItemId,
      }
    : null;
}
