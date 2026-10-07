import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { DownloadItem, DownloadList, ServerEvent } from '@lumiere/shared';
import { queryKeys } from './queries';

/** Une seule notification, mise à jour à chaque étape de la vérification Cloudflare. */
const VERIFICATION_TOAST = 'source-verification';

function showVerification(event: Extract<ServerEvent, { type: 'source.verification' }>): void {
  switch (event.state) {
    case 'opening':
      toast.loading(event.message, {
        id: VERIFICATION_TOAST,
        description: 'La fenêtre se fermera d’elle-même une fois la vérification passée.',
        duration: Infinity,
      });
      break;
    case 'waiting':
      toast.warning('Vérification Cloudflare en attente', {
        id: VERIFICATION_TOAST,
        description: event.message,
        duration: Infinity,
      });
      break;
    case 'passed':
      toast.success(event.message, { id: VERIFICATION_TOAST, description: undefined });
      break;
    case 'failed':
      toast.error('Vérification Cloudflare impossible', {
        id: VERIFICATION_TOAST,
        description: event.message,
        duration: 15_000,
      });
      break;
  }
}

function upsert(list: DownloadList, item: DownloadItem): DownloadList {
  const exists = list.items.some((entry) => entry.id === item.id);
  return {
    ...list,
    items: exists
      ? list.items.map((entry) => (entry.id === item.id ? item : entry))
      : [...list.items, item],
  };
}

/**
 * Abonnement au flux temps réel du serveur (Server-Sent Events) : met à jour le cache
 * TanStack Query (progression des téléchargements) et invalide les vues concernées.
 */
export function useServerEvents(): { connected: boolean } {
  const client = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const pending = new Map<string, QueryKey>();
    let timer: number | undefined;
    const invalidate = (...keys: QueryKey[]) => {
      for (const key of keys) pending.set(JSON.stringify(key), key);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        for (const key of pending.values()) void client.invalidateQueries({ queryKey: key });
        pending.clear();
      }, 600);
    };

    const previousStatus = new Map<number, string>();
    const source = new EventSource('/api/events');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message: MessageEvent<string>) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(message.data) as ServerEvent;
      } catch {
        return;
      }
      switch (event.type) {
        case 'download.updated': {
          client.setQueryData<DownloadList>(queryKeys.downloads, (old) =>
            old ? upsert(old, event.download) : old,
          );
          const before = previousStatus.get(event.download.id);
          if (before !== event.download.status) {
            previousStatus.set(event.download.id, event.download.status);
            invalidate(['title'], ['explorer']);
          }
          break;
        }
        case 'download.removed':
          client.setQueryData<DownloadList>(queryKeys.downloads, (old) =>
            old ? { ...old, items: old.items.filter((entry) => entry.id !== event.id) } : old,
          );
          break;
        case 'downloads.stats':
          client.setQueryData<DownloadList>(queryKeys.downloads, (old) =>
            old ? { ...old, stats: event.stats } : old,
          );
          break;
        case 'library.changed':
          invalidate(
            queryKeys.library,
            queryKeys.home,
            ['titles'],
            ['title'],
            queryKeys.continueWatching,
          );
          break;
        case 'catalog.updated':
          invalidate(queryKeys.system);
          if (event.status.state !== 'refreshing')
            invalidate(queryKeys.home, ['titles'], ['genres']);
          break;
        case 'metadata.updated':
          invalidate(queryKeys.title(event.titleId), queryKeys.home, ['titles'], ['genres']);
          break;
        case 'source.verification':
          showVerification(event);
          if (event.state === 'passed') invalidate(queryKeys.system, ['explorer']);
          break;
      }
    };
    return () => {
      window.clearTimeout(timer);
      source.close();
    };
  }, [client]);

  return { connected };
}
