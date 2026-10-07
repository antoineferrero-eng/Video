const BYTE_UNITS = ['o', 'Ko', 'Mo', 'Go', 'To'];

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit >= 3 ? 2 : unit === 0 ? 0 : 1;
  return `${value.toLocaleString('fr-FR', { maximumFractionDigits: digits })} ${BYTE_UNITS[unit]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** Durée lisible : « 1 h 32 min », « 45 min », « 30 s ». */
export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds < 0) return '';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours > 0)
    return minutes > 0 ? `${hours} h ${String(minutes).padStart(2, '0')}` : `${hours} h`;
  if (minutes > 0) return `${minutes} min`;
  return `${Math.round(seconds)} s`;
}

/** Horodatage de lecteur : « 1:02:03 » ou « 2:03 ». */
export function formatClock(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.floor(seconds ?? 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours > 0 ? `${hours}:` : ''}${mm}:${String(secs).padStart(2, '0')}`;
}

export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const hours = Math.floor(seconds / 3600);
  return `${hours} h ${String(Math.round((seconds % 3600) / 60)).padStart(2, '0')}`;
}

const relative = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });

export function formatRelativeDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const diff = (Date.parse(iso) - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return "à l'instant";
  if (abs < 3600) return relative.format(Math.round(diff / 60), 'minute');
  if (abs < 86_400) return relative.format(Math.round(diff / 3600), 'hour');
  if (abs < 86_400 * 30) return relative.format(Math.round(diff / 86_400), 'day');
  if (abs < 86_400 * 365) return relative.format(Math.round(diff / (86_400 * 30)), 'month');
  return relative.format(Math.round(diff / (86_400 * 365)), 'year');
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export function formatRating(rating: number | null | undefined): string | null {
  if (rating === null || rating === undefined || rating <= 0) return null;
  return rating.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

export function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function episodeCode(season: number | null, episode: number | null): string | null {
  if (episode === null) return season === null ? null : `S${pad2(season)}`;
  return season === null ? `E${pad2(episode)}` : `S${pad2(season)}E${pad2(episode)}`;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString('fr-FR')} ${count > 1 ? pluralForm : singular}`;
}
