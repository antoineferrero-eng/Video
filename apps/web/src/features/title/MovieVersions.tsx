import { FileVideo, Subtitles } from 'lucide-react';
import type { TitleDetails } from '@lumiere/shared';
import { ReleaseBadges } from '../../components/media/ReleaseBadges';
import { EmptyState } from '../../components/ui/States';
import { formatBytes, formatDate } from '../../lib/format';
import { DownloadState, PlayButton, WatchProgress, WatchedToggle } from './FileActions';
import { isAddonPath } from './file-utils';

const LANGUAGE_NAMES: Record<string, string> = {
  fr: 'Français',
  en: 'Anglais',
  es: 'Espagnol',
  de: 'Allemand',
  it: 'Italien',
};

/** Versions disponibles d'un film (qualités, langues…). */
export function MovieVersions({ title }: { title: TitleDetails }) {
  if (title.files.length === 0) {
    return (
      <EmptyState
        icon={<FileVideo />}
        title="Aucun fichier vidéo"
        description={
          isAddonPath(title.remotePath)
            ? 'L’extension Stremio ne propose aucun fichier pour ce film pour le moment.'
            : 'Le dossier de ce film ne contient pas de vidéo reconnue.'
        }
      />
    );
  }
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-bold tracking-tight">
        {title.files.length > 1
          ? `${title.files.length} versions disponibles`
          : 'Fichier disponible'}
      </h2>
      <div className="flex flex-col gap-2">
        {title.files.map((file) => (
          <div
            key={file.path}
            className="fill flex flex-col gap-3 rounded-card p-4 sm:flex-row sm:items-center"
          >
            <div className="min-w-0 flex-1">
              <ReleaseBadges release={file.release} />
              <p className="mt-2 truncate font-mono text-xs text-zinc-300" title={file.name}>
                {file.name}
              </p>
              {file.label && (
                <p className="mt-0.5 truncate text-xs text-zinc-500" title={file.label}>
                  {file.label}
                </p>
              )}
              <p className="mt-1 text-xs text-zinc-400">
                {formatBytes(file.size)}
                {file.modifiedAt && ` · ajouté le ${formatDate(file.modifiedAt)}`}
              </p>
              <WatchProgress file={file} className="mt-2 max-w-xs" />
            </div>
            <div className="flex items-center gap-2">
              <WatchedToggle file={file} />
              <DownloadState file={file} titleId={title.id} />
              <PlayButton file={file} />
            </div>
          </div>
        ))}
      </div>
      {title.subtitles.length > 0 && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-zinc-300">
          <Subtitles className="size-4" />
          Sous-titres disponibles :
          {title.subtitles.map((subtitle) => (
            <span key={subtitle.path} className="fill rounded-full px-2.5 py-0.5 text-xs">
              {(subtitle.language && LANGUAGE_NAMES[subtitle.language]) ??
                subtitle.language?.toUpperCase() ??
                subtitle.name}
            </span>
          ))}
        </p>
      )}
    </section>
  );
}
