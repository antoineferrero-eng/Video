import {
  ChevronRight,
  Download,
  File,
  FileText,
  FileVideo,
  Folder,
  FolderDown,
  Home,
  Play,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { ExplorerEntry } from '@lumiere/shared';
import { useEnqueueFiles, useEnqueueFolder, useExplorer } from '../../api/queries';
import { useQueryClient } from '@tanstack/react-query';
import { ReleaseBadges } from '../../components/media/ReleaseBadges';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { PageLoader } from '../../components/ui/Spinner';
import { EmptyState, ErrorState } from '../../components/ui/States';
import { Glass } from '../../design/glass/Glass';
import { cn } from '../../lib/cn';
import { formatBytes, formatDate } from '../../lib/format';
import { explorerUrl, playerUrl } from '../../lib/routes';
import { api } from '../../api/client';

const ICONS = { directory: Folder, video: FileVideo, subtitle: FileText, other: File };

/** Navigation brute dans l'arborescence de la source, indépendante du catalogue. */
export function ExplorerPage() {
  const [params] = useSearchParams();
  const path = params.get('path') || '/';
  const listing = useExplorer(path);
  const client = useQueryClient();
  const enqueueFolder = useEnqueueFolder();
  const [filter, setFilter] = useState('');
  const [confirmFolder, setConfirmFolder] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const entries = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = listing.data?.entries ?? [];
    return needle ? all.filter((entry) => entry.name.toLowerCase().includes(needle)) : all;
  }, [listing.data, filter]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const fresh = await api('/explorer', { query: { path, refresh: true } });
      client.setQueryData(['explorer', path], fresh);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <h1 className="large-title">Explorateur</h1>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-56 flex-1 sm:flex-none">
              <Search className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-zinc-400" />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filtrer ce dossier…"
                aria-label="Filtrer ce dossier"
                className="input pl-10 sm:w-60"
              />
            </div>
            <Button
              variant="glass"
              size="icon"
              className="size-11"
              aria-label="Actualiser le dossier"
              title="Actualiser"
              onClick={() => void refresh()}
            >
              <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
            </Button>
            {path !== '/' && (
              <Button
                variant="glass"
                className="h-11"
                icon={<FolderDown className="size-4" />}
                onClick={() => setConfirmFolder(path)}
              >
                Télécharger le dossier
              </Button>
            )}
          </div>
        </div>
        {/* Barre de chemin en verre (comme celle du Finder). */}
        <Glass
          as="nav"
          aria-label="Fil d'Ariane"
          className="scrollbar-none flex max-w-full items-center gap-0.5 self-start overflow-x-auto rounded-full p-1 text-sm"
        >
          <Link
            to={explorerUrl('/')}
            className="flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-zinc-200 transition hover:bg-white/10 hover:text-white"
          >
            <Home className="size-3.5" /> Racine
          </Link>
          {listing.data?.breadcrumbs.map((crumb, position, all) => (
            <span key={crumb.path} className="flex shrink-0 items-center gap-0.5">
              <ChevronRight className="size-3.5 text-zinc-400" />
              <Link
                to={explorerUrl(crumb.path)}
                aria-current={position === all.length - 1 ? 'page' : undefined}
                className={cn(
                  'max-w-64 truncate rounded-full px-3 py-1.5 transition hover:bg-white/10 hover:text-white',
                  position === all.length - 1
                    ? 'bg-white/[0.12] font-medium text-white'
                    : 'text-zinc-200',
                )}
              >
                {crumb.name}
              </Link>
            </span>
          ))}
        </Glass>
      </header>

      {listing.isPending ? (
        <PageLoader label="Lecture du dossier distant…" />
      ) : listing.isError ? (
        <ErrorState error={listing.error} onRetry={() => void listing.refetch()} />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<Folder />}
          title={filter ? 'Aucun élément ne correspond au filtre' : 'Dossier vide'}
        />
      ) : (
        <div
          className={cn(
            'fill overflow-hidden rounded-card',
            listing.isPlaceholderData && 'opacity-60',
          )}
        >
          <div className="hidden grid-cols-[1fr_7rem_10rem_auto] gap-4 border-b border-white/[0.07] px-4 py-2.5 text-xs font-semibold text-zinc-400 md:grid">
            <span>Nom</span>
            <span className="text-right">Taille</span>
            <span>Modifié</span>
            <span className="w-28" />
          </div>
          <ul className="divide-y divide-white/[0.06]">
            {entries.map((entry) => (
              <EntryRow
                key={entry.path}
                entry={entry}
                onDownloadFolder={() => setConfirmFolder(entry.path)}
              />
            ))}
          </ul>
        </div>
      )}
      {listing.data && (
        <p className="px-1 text-xs text-zinc-400">
          {listing.data.entries.length} élément(s) · format de listing détecté :{' '}
          {listing.data.format} · <span className="font-mono">{listing.data.sourceUrl}</span>
        </p>
      )}

      <Dialog
        open={confirmFolder !== null}
        onClose={() => setConfirmFolder(null)}
        title="Télécharger tout le dossier ?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmFolder(null)}>
              Annuler
            </Button>
            <Button
              variant="primary"
              icon={<Download className="size-4" />}
              loading={enqueueFolder.isPending}
              onClick={() => {
                if (confirmFolder)
                  enqueueFolder.mutate(confirmFolder, { onSettled: () => setConfirmFolder(null) });
              }}
            >
              Tout télécharger
            </Button>
          </>
        }
      >
        Toutes les vidéos de{' '}
        <span className="font-mono break-all text-zinc-100">{confirmFolder}</span> (et de ses
        sous-dossiers) seront ajoutées à la file de téléchargement.
      </Dialog>
    </div>
  );
}

function EntryRow({
  entry,
  onDownloadFolder,
}: {
  entry: ExplorerEntry;
  onDownloadFolder: () => void;
}) {
  const navigate = useNavigate();
  const enqueue = useEnqueueFiles();
  const Icon = ICONS[entry.kind];
  const availability = entry.availability;
  const downloaded =
    availability?.libraryItemId !== null && availability?.libraryItemId !== undefined;
  const inProgress =
    availability?.download &&
    ['queued', 'downloading', 'paused'].includes(availability.download.status);

  const content = (
    <>
      <Icon
        className={cn(
          'size-5 shrink-0',
          entry.kind === 'directory'
            ? 'text-brand-300'
            : entry.kind === 'video'
              ? 'text-sky-300'
              : 'text-zinc-400',
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-zinc-100" title={entry.name}>
          {entry.name}
        </p>
        {entry.release && (entry.release.resolution || entry.release.languages.length > 0) && (
          <div className="mt-1">
            <ReleaseBadges release={entry.release} compact />
          </div>
        )}
      </div>
    </>
  );

  return (
    <li className="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-2.5 transition hover:bg-white/[0.05] md:grid-cols-[1fr_7rem_10rem_auto]">
      {entry.kind === 'directory' ? (
        <Link to={explorerUrl(entry.path)} className="flex min-w-0 items-center gap-3">
          {content}
        </Link>
      ) : (
        <div className="flex min-w-0 items-center gap-3">{content}</div>
      )}
      <span className="hidden text-right text-sm text-zinc-300 tabular-nums md:block">
        {entry.kind === 'directory' ? '—' : formatBytes(entry.size)}
      </span>
      <span className="hidden text-sm text-zinc-400 md:block">{formatDate(entry.modifiedAt)}</span>
      <div className="flex w-28 items-center justify-end gap-1">
        {entry.kind === 'directory' && (
          <Button
            variant="ghost"
            size="icon-sm"
            title="Télécharger le dossier"
            onClick={onDownloadFolder}
          >
            <FolderDown className="size-4" />
          </Button>
        )}
        {entry.kind === 'video' && (
          <>
            {downloaded ? (
              <Badge tone="success">Téléchargé</Badge>
            ) : inProgress ? (
              <Link to="/telechargements">
                <Badge tone="brand">
                  {availability?.download?.progress !== null &&
                  availability?.download?.progress !== undefined
                    ? `${Math.round(availability.download.progress * 100)} %`
                    : 'En file'}
                </Badge>
              </Link>
            ) : (
              <Button
                variant="ghost"
                size="icon-sm"
                title="Télécharger"
                loading={enqueue.isPending}
                onClick={() => enqueue.mutate([{ path: entry.path }])}
              >
                <Download className="size-4" />
              </Button>
            )}
            <Button
              variant="primary"
              size="icon-sm"
              title="Lire"
              onClick={() =>
                navigate(
                  playerUrl(
                    downloaded
                      ? { type: 'library', id: availability?.libraryItemId as number }
                      : { type: 'remote', path: entry.path },
                  ),
                )
              }
            >
              <Play className="size-4 fill-current" />
            </Button>
          </>
        )}
        {entry.kind !== 'directory' && entry.kind !== 'video' && (
          <Button
            variant="ghost"
            size="icon-sm"
            title="Télécharger"
            onClick={() => enqueue.mutate([{ path: entry.path }])}
          >
            <Download className="size-4" />
          </Button>
        )}
      </div>
    </li>
  );
}
