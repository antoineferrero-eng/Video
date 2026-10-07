import {
  FileVideo,
  Film,
  HardDrive,
  Library as LibraryIcon,
  MonitorDown,
  Play,
  ScanSearch,
  Trash2,
  Tv,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { LibraryItem } from '@lumiere/shared';
import { useLibrary, useRemoveLibraryItem, useScanLibrary, useSystemInfo } from '../../api/queries';
import { Poster } from '../../components/media/Poster';
import { ReleaseBadges } from '../../components/media/ReleaseBadges';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { PageLoader } from '../../components/ui/Spinner';
import { EmptyState, ErrorState } from '../../components/ui/States';
import { Tabs } from '../../components/ui/Tabs';
import { episodeCode, formatBytes, formatRelativeDate, plural } from '../../lib/format';
import { playerUrl } from '../../lib/routes';
import { POSTER_GRID } from '../../components/media/grid';

type Tab = 'movie' | 'episode' | 'other';

export function LibraryPage() {
  const library = useLibrary();
  const system = useSystemInfo();
  const scan = useScanLibrary();
  const [tab, setTab] = useState<Tab>('movie');
  const [toDelete, setToDelete] = useState<LibraryItem | null>(null);
  const items = useMemo(() => library.data ?? [], [library.data]);

  if (library.isPending) return <PageLoader />;
  if (library.isError)
    return <ErrorState error={library.error} onRetry={() => void library.refetch()} />;

  const byKind = (kind: Tab) => items.filter((item) => item.kind === kind);
  const totalSize = items.reduce((sum, item) => sum + item.size, 0);
  const disk = system.data?.disk;
  const current = byKind(tab);

  return (
    <div className="flex flex-col gap-6 pt-2">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Ma bibliothèque</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-zinc-400">
            <span>
              {plural(items.length, 'fichier')} · {formatBytes(totalSize)}
            </span>
            {disk && (
              <span className="flex items-center gap-1.5">
                <HardDrive className="size-3.5" />
                {formatBytes(disk.free)} libres sur {formatBytes(disk.total)}
              </span>
            )}
          </p>
          {system.data && (
            <p className="mt-1 truncate font-mono text-xs text-zinc-500">
              {system.data.downloadDir}
            </p>
          )}
        </div>
        <Button
          icon={<ScanSearch className="size-4" />}
          loading={scan.isPending}
          onClick={() => scan.mutate()}
        >
          Analyser le dossier
        </Button>
      </header>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        items={[
          { value: 'movie', label: 'Films', count: byKind('movie').length },
          { value: 'episode', label: 'Séries', count: byKind('episode').length },
          { value: 'other', label: 'Autres', count: byKind('other').length },
        ]}
      />

      {current.length === 0 ? (
        <EmptyState
          icon={tab === 'movie' ? <Film /> : tab === 'episode' ? <Tv /> : <FileVideo />}
          title="Rien ici pour le moment"
          description="Les fichiers téléchargés apparaissent automatiquement dans votre bibliothèque et se lisent hors ligne."
        />
      ) : tab === 'movie' ? (
        <div className={POSTER_GRID}>
          {current.map((item) => (
            <MovieTile key={item.id} item={item} onDelete={() => setToDelete(item)} />
          ))}
        </div>
      ) : tab === 'episode' ? (
        <SeriesGroups items={current} onDelete={setToDelete} />
      ) : (
        <div className="flex flex-col gap-2">
          {current.map((item) => (
            <ItemRow key={item.id} item={item} onDelete={() => setToDelete(item)} showTitle />
          ))}
        </div>
      )}

      <DeleteDialog item={toDelete} onClose={() => setToDelete(null)} />
    </div>
  );
}

function MovieTile({ item, onDelete }: { item: LibraryItem; onDelete: () => void }) {
  const progress = item.watch?.duration ? item.watch.position / item.watch.duration : null;
  return (
    <div className="group flex flex-col gap-2">
      <Link
        to={playerUrl({ type: 'library', id: item.id })}
        className="relative overflow-hidden rounded-xl ring-1 ring-white/[0.06] transition hover:ring-brand-400/50"
      >
        <Poster url={item.posterUrl} title={item.title} year={item.year} />
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition group-hover:opacity-100">
          <span className="flex size-14 items-center justify-center rounded-full bg-white/90 text-ink-950">
            <Play className="ml-0.5 size-6 fill-current" />
          </span>
        </div>
        {!item.exists && (
          <Badge tone="danger" className="absolute top-2 left-2">
            Fichier introuvable
          </Badge>
        )}
        {item.watch && (
          <ProgressBar
            value={item.watch.completed ? 1 : progress}
            tone={item.watch.completed ? 'success' : 'brand'}
            className="absolute inset-x-0 bottom-0 h-1 rounded-none"
          />
        )}
      </Link>
      <div className="flex items-start justify-between gap-2 px-0.5">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{item.title}</p>
          <p className="truncate text-xs text-zinc-500">
            {[item.year, item.release.resolution, formatBytes(item.size)]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <ItemMenu item={item} onDelete={onDelete} />
      </div>
    </div>
  );
}

function ItemMenu({ item, onDelete }: { item: LibraryItem; onDelete: () => void }) {
  return (
    <div className="flex shrink-0 items-center">
      <a
        href={`/api/library/${item.id}/file`}
        download={item.fileName}
        title="Enregistrer sur cet appareil"
        className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200"
      >
        <MonitorDown className="size-4" />
      </a>
      <button
        type="button"
        onClick={onDelete}
        title="Supprimer"
        className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-red-500/10 hover:text-red-300"
      >
        <Trash2 className="size-4" />
      </button>
    </div>
  );
}

function SeriesGroups({
  items,
  onDelete,
}: {
  items: LibraryItem[];
  onDelete: (item: LibraryItem) => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, LibraryItem[]>();
    for (const item of items) {
      const key = item.titleId !== null ? `id:${item.titleId}` : `t:${item.title}`;
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    return [...map.values()].map((episodes) =>
      episodes.sort(
        (a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0),
      ),
    );
  }, [items]);

  return (
    <div className="flex flex-col gap-6">
      {groups.map((episodes) => {
        const first = episodes[0] as LibraryItem;
        return (
          <section key={`${first.titleId}-${first.title}`} className="surface overflow-hidden">
            <div className="flex items-center gap-4 border-b border-white/5 p-4">
              <Poster
                url={first.posterUrl}
                title={first.title}
                kind="series"
                className="w-14 shrink-0 rounded-lg [&_p]:text-[8px] [&_svg]:hidden"
              />
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-lg font-semibold">{first.title}</h2>
                <p className="text-sm text-zinc-400">
                  {plural(episodes.length, 'épisode')} ·{' '}
                  {formatBytes(episodes.reduce((sum, item) => sum + item.size, 0))}
                </p>
              </div>
              {first.titleId !== null && (
                <Link
                  to={`/titre/${first.titleId}`}
                  className="text-sm font-medium text-brand-300 hover:text-brand-200"
                >
                  Voir la série
                </Link>
              )}
            </div>
            <div className="flex flex-col divide-y divide-white/5">
              {episodes.map((item) => (
                <ItemRow key={item.id} item={item} onDelete={() => onDelete(item)} flat />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ItemRow({
  item,
  onDelete,
  showTitle = false,
  flat = false,
}: {
  item: LibraryItem;
  onDelete: () => void;
  showTitle?: boolean;
  flat?: boolean;
}) {
  const navigate = useNavigate();
  const code = episodeCode(item.season, item.episode);
  const progress = item.watch?.duration ? item.watch.position / item.watch.duration : null;
  return (
    <div
      className={flat ? 'flex items-center gap-3 px-4 py-3' : 'surface flex items-center gap-3 p-3'}
    >
      <Button
        variant="primary"
        size="icon-sm"
        title="Lire"
        onClick={() => navigate(playerUrl({ type: 'library', id: item.id }))}
        disabled={!item.exists}
      >
        <Play className="size-4 fill-current" />
      </Button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {code && <span className="mr-2 text-brand-300">{code}</span>}
          {showTitle ? item.title : item.fileName}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <ReleaseBadges release={item.release} compact />
          <span>{formatBytes(item.size)}</span>
          <span>· ajouté {formatRelativeDate(item.addedAt)}</span>
          {item.watch?.completed && <Badge tone="success">Vu</Badge>}
          {!item.exists && <Badge tone="danger">Fichier introuvable</Badge>}
        </div>
        {item.watch && !item.watch.completed && (
          <ProgressBar value={progress} className="mt-2 h-1 max-w-xs" />
        )}
      </div>
      <ItemMenu item={item} onDelete={onDelete} />
    </div>
  );
}

function DeleteDialog({ item, onClose }: { item: LibraryItem | null; onClose: () => void }) {
  const remove = useRemoveLibraryItem();
  return (
    <Dialog
      open={item !== null}
      onClose={onClose}
      title="Supprimer de la bibliothèque ?"
      footer={
        item && (
          <>
            <Button variant="ghost" onClick={onClose}>
              Annuler
            </Button>
            <Button
              onClick={() => {
                remove.mutate({ id: item.id, deleteFile: false });
                onClose();
              }}
            >
              Retirer seulement
            </Button>
            <Button
              variant="danger"
              icon={<Trash2 className="size-4" />}
              onClick={() => {
                remove.mutate({ id: item.id, deleteFile: true });
                onClose();
              }}
            >
              Supprimer le fichier
            </Button>
          </>
        )
      }
    >
      {item && (
        <div className="flex items-start gap-3">
          <LibraryIcon className="mt-0.5 size-5 shrink-0 text-zinc-500" />
          <p>
            <span className="font-medium text-zinc-100">{item.fileName}</span> (
            {formatBytes(item.size)}). « Supprimer le fichier » libère l'espace disque ; « Retirer
            seulement » conserve le fichier sur le disque.
          </p>
        </div>
      )}
    </Dialog>
  );
}
