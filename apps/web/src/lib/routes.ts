import type { MediaRef } from '@lumiere/shared';

/** URL du lecteur pour un média distant, local, ou un épisode choisi à la lecture. */
export function playerUrl(media: MediaRef, start?: number): string {
  const params = new URLSearchParams();
  if (media.type === 'remote') params.set('remote', media.path);
  else if (media.type === 'library') params.set('library', String(media.id));
  else params.set('episode', `${media.titleId}:${media.season}:${media.episode}`);
  if (start !== undefined) params.set('t', String(Math.floor(start)));
  return `/lecture?${params.toString()}`;
}

export function mediaFromSearch(params: URLSearchParams): MediaRef | null {
  const remote = params.get('remote');
  if (remote) return { type: 'remote', path: remote };
  const episode = /^(\d+):(\d+):(\d+)$/.exec(params.get('episode') ?? '');
  if (episode) {
    return {
      type: 'episode',
      titleId: Number(episode[1]),
      season: Number(episode[2]),
      episode: Number(episode[3]),
    };
  }
  const library = Number(params.get('library'));
  return Number.isInteger(library) && library > 0 ? { type: 'library', id: library } : null;
}

export function explorerUrl(path: string): string {
  return `/explorateur?path=${encodeURIComponent(path)}`;
}
