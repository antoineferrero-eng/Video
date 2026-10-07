import type { MediaRef } from '@lumiere/shared';

/** URL du lecteur pour un média distant ou local. */
export function playerUrl(media: MediaRef, start?: number): string {
  const params = new URLSearchParams();
  if (media.type === 'remote') params.set('remote', media.path);
  else params.set('library', String(media.id));
  if (start !== undefined) params.set('t', String(Math.floor(start)));
  return `/lecture?${params.toString()}`;
}

export function mediaFromSearch(params: URLSearchParams): MediaRef | null {
  const remote = params.get('remote');
  if (remote) return { type: 'remote', path: remote };
  const library = Number(params.get('library'));
  return Number.isInteger(library) && library > 0 ? { type: 'library', id: library } : null;
}

export function explorerUrl(path: string): string {
  return `/explorateur?path=${encodeURIComponent(path)}`;
}
