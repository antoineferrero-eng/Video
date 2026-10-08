import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  AddonTestResult,
  CatalogQuery,
  CatalogSectionStatus,
  ContinueWatchingItem,
  DownloadItem,
  DownloadList,
  DownloadStats,
  EnqueueResult,
  EpisodeFiles,
  GenreCount,
  HomeFeed,
  LibraryItem,
  LibraryScanResult,
  MediaRef,
  Page,
  SettingsResponse,
  SettingsUpdate,
  SubtitleProvidersTestResult,
  SystemInfo,
  TitleDetails,
  TitleKind,
  TitleSummary,
} from '@lumiere/shared';
import { toast } from 'sonner';
import { plural } from '../lib/format';
import { api, errorMessage } from './client';

export const queryKeys = {
  home: ['home'] as const,
  titles: (query: CatalogQuery) => ['titles', query] as const,
  title: (id: number) => ['title', id] as const,
  genres: (kind?: TitleKind) => ['genres', kind ?? 'all'] as const,
  downloads: ['downloads'] as const,
  library: ['library'] as const,
  continueWatching: ['continue-watching'] as const,
  settings: ['settings'] as const,
  system: ['system'] as const,
};

// ---------------------------------------------------------------------------
// Lectures
// ---------------------------------------------------------------------------

export function useHome() {
  return useQuery({ queryKey: queryKeys.home, queryFn: () => api<HomeFeed>('/home') });
}

export function useCatalog(query: Omit<CatalogQuery, 'page'>) {
  return useInfiniteQuery({
    queryKey: queryKeys.titles(query),
    queryFn: ({ pageParam }) =>
      api<Page<TitleSummary>>('/titles', {
        query: { ...query, page: pageParam, pageSize: query.pageSize ?? 48 },
      }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
    placeholderData: keepPreviousData,
  });
}

export function useTitleSearch(q: string, kind: TitleKind) {
  return useQuery({
    queryKey: queryKeys.titles({ q, kind, pageSize: 24 }),
    queryFn: () => api<Page<TitleSummary>>('/titles', { query: { q, kind, pageSize: 24 } }),
    enabled: q.trim().length > 0,
    placeholderData: keepPreviousData,
  });
}

export function useTitle(id: number) {
  return useQuery({
    queryKey: queryKeys.title(id),
    queryFn: () => api<TitleDetails>(`/titles/${id}`),
    enabled: Number.isFinite(id),
  });
}

/**
 * Versions d'un épisode proposées par les extensions Stremio : chaque demande peut consommer des
 * liens, elle n'est donc faite qu'à l'ouverture de la liste des versions.
 */
export function useEpisodeFiles(
  titleId: number,
  season: number,
  episode: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['title', titleId, 'episode', season, episode] as const,
    queryFn: () => api<EpisodeFiles>(`/titles/${titleId}/episodes/${season}/${episode}`),
    enabled,
    staleTime: 10 * 60_000,
  });
}

export function useGenres(kind?: TitleKind) {
  return useQuery({
    queryKey: queryKeys.genres(kind),
    queryFn: () => api<GenreCount[]>('/genres', { query: { kind } }),
    staleTime: 5 * 60_000,
  });
}

export function useDownloads() {
  return useQuery({
    queryKey: queryKeys.downloads,
    queryFn: () => api<DownloadList>('/downloads'),
  });
}

export function useLibrary() {
  return useQuery({ queryKey: queryKeys.library, queryFn: () => api<LibraryItem[]>('/library') });
}

export function useContinueWatching() {
  return useQuery({
    queryKey: queryKeys.continueWatching,
    queryFn: () => api<ContinueWatchingItem[]>('/playback/continue'),
  });
}

export function useSettings() {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => api<SettingsResponse>('/settings'),
  });
}

export function useSystemInfo() {
  return useQuery({
    queryKey: queryKeys.system,
    queryFn: () => api<SystemInfo>('/system'),
    refetchInterval: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Téléchargements
// ---------------------------------------------------------------------------

function reportEnqueue(result: EnqueueResult): void {
  const created = result.created.length;
  const pending = result.pending ?? 0;
  if (created === 1)
    toast.success('Téléchargement ajouté', { description: result.created[0]?.fileName });
  else if (created > 1) toast.success(`${created} téléchargements ajoutés`);
  if (pending > 0) {
    toast.info(`${plural(pending, 'épisode')} en cours d’ajout`, {
      description:
        'Les liens sont demandés un par un aux extensions Stremio ; le bilan s’affichera ici.',
    });
  }
  if (created === 0 && pending === 0 && result.skipped.length > 0) {
    toast.info(result.skipped[0]?.reason ?? 'Rien à télécharger');
  } else if (result.skipped.length > 0) {
    toast.info(`${result.skipped.length} fichier(s) ignoré(s)`, {
      description: result.skipped[0]?.reason,
    });
  }
}

function useInvalidateAfterDownload() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: queryKeys.downloads });
    void client.invalidateQueries({ queryKey: ['title'] });
  };
}

export function useEnqueueFiles() {
  const invalidate = useInvalidateAfterDownload();
  return useMutation({
    mutationFn: (files: Array<{ path: string; titleId?: number | null }>) =>
      api<EnqueueResult>('/downloads', { method: 'POST', body: { files } }),
    onSuccess: (result) => {
      reportEnqueue(result);
      invalidate();
    },
    onError: (error) => toast.error('Ajout impossible', { description: errorMessage(error) }),
  });
}

export function useEnqueueTitle() {
  const invalidate = useInvalidateAfterDownload();
  return useMutation({
    mutationFn: (input: { titleId: number; season?: number | null; episode?: number | null }) =>
      api<EnqueueResult>('/downloads/title', { method: 'POST', body: input }),
    onSuccess: (result) => {
      reportEnqueue(result);
      invalidate();
    },
    onError: (error) => toast.error('Ajout impossible', { description: errorMessage(error) }),
  });
}

export function useEnqueueFolder() {
  const invalidate = useInvalidateAfterDownload();
  return useMutation({
    mutationFn: (path: string) =>
      api<EnqueueResult>('/downloads/folder', { method: 'POST', body: { path } }),
    onSuccess: (result) => {
      reportEnqueue(result);
      invalidate();
    },
    onError: (error) => toast.error('Ajout impossible', { description: errorMessage(error) }),
  });
}

export function useDownloadAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'pause' | 'resume' | 'cancel' }) =>
      api<DownloadItem>(`/downloads/${id}/${action}`, { method: 'POST' }),
    onSuccess: (item) => {
      client.setQueryData<DownloadList>(queryKeys.downloads, (old) =>
        old
          ? { ...old, items: old.items.map((entry) => (entry.id === item.id ? item : entry)) }
          : old,
      );
    },
    onError: (error) => toast.error('Action impossible', { description: errorMessage(error) }),
  });
}

export function useRemoveDownload() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, deleteFile }: { id: number; deleteFile: boolean }) =>
      api<void>(`/downloads/${id}`, { method: 'DELETE', query: { deleteFile } }),
    onSuccess: (_, { id }) => {
      client.setQueryData<DownloadList>(queryKeys.downloads, (old) =>
        old ? { ...old, items: old.items.filter((entry) => entry.id !== id) } : old,
      );
      void client.invalidateQueries({ queryKey: ['title'] });
    },
    onError: (error) => toast.error('Suppression impossible', { description: errorMessage(error) }),
  });
}

export function useBulkDownloadAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (action: 'pause-all' | 'resume-all' | 'clear') =>
      api<DownloadStats | { removed: number }>(`/downloads/${action}`, { method: 'POST' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.downloads }),
    onError: (error) => toast.error('Action impossible', { description: errorMessage(error) }),
  });
}

// ---------------------------------------------------------------------------
// Bibliothèque, lecture, catalogue, paramètres
// ---------------------------------------------------------------------------

export function useRemoveLibraryItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, deleteFile }: { id: number; deleteFile: boolean }) =>
      api<void>(`/library/${id}`, { method: 'DELETE', query: { deleteFile } }),
    onSuccess: (_, { deleteFile }) => {
      toast.success(deleteFile ? 'Fichier supprimé' : 'Retiré de la bibliothèque');
      void client.invalidateQueries({ queryKey: queryKeys.library });
      void client.invalidateQueries({ queryKey: ['title'] });
    },
    onError: (error) => toast.error('Suppression impossible', { description: errorMessage(error) }),
  });
}

export function useScanLibrary() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<LibraryScanResult>('/library/scan', { method: 'POST' }),
    onSuccess: (result) => {
      toast.success('Bibliothèque analysée', {
        description: `${result.added} ajout(s), ${result.removed} retrait(s) — ${result.total} fichier(s)`,
      });
      void client.invalidateQueries({ queryKey: queryKeys.library });
    },
    onError: (error) => toast.error('Analyse impossible', { description: errorMessage(error) }),
  });
}

export function useSetWatched() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { media: MediaRef; watched: boolean }) =>
      api<void>('/playback/watched', { method: 'PUT', body: input }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['title'] });
      void client.invalidateQueries({ queryKey: queryKeys.continueWatching });
      void client.invalidateQueries({ queryKey: queryKeys.library });
    },
  });
}

export function useRemoveProgress() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (mediaKey: string) =>
      api<void>('/playback/progress', { method: 'DELETE', query: { mediaKey } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.continueWatching }),
  });
}

export function useRefreshCatalog() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (kind?: TitleKind) =>
      api<CatalogSectionStatus[]>('/catalog/refresh', {
        method: 'POST',
        body: kind ? { kind } : {},
      }),
    onSuccess: () => {
      toast.info('Actualisation du catalogue lancée');
      void client.invalidateQueries({ queryKey: queryKeys.system });
    },
    onError: (error) =>
      toast.error('Actualisation impossible', { description: errorMessage(error) }),
  });
}

export function useUpdateSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (update: SettingsUpdate) =>
      api<SettingsResponse>('/settings', { method: 'PATCH', body: update }),
    onSuccess: (response) => {
      client.setQueryData(queryKeys.settings, response);
      void client.invalidateQueries({ queryKey: queryKeys.system });
      toast.success('Paramètres enregistrés');
    },
    onError: (error) =>
      toast.error('Enregistrement impossible', { description: errorMessage(error) }),
  });
}

export function useTestAddon() {
  return useMutation({
    mutationFn: (url?: string) =>
      api<AddonTestResult>('/settings/test-addon', {
        method: 'POST',
        body: url ? { url } : {},
      }),
  });
}

/** Test des services de sous-titres en ligne avec les valeurs saisies. */
export function useTestSubtitles() {
  return useMutation({
    mutationFn: (candidate: {
      openSubtitlesApiKey?: string;
      openSubtitlesUsername?: string;
      openSubtitlesPassword?: string;
      subtitleAddonUrls?: string[];
      /** Services à tester (tous par défaut). */
      providers?: Array<'opensubtitles' | 'addons'>;
    }) =>
      api<SubtitleProvidersTestResult>('/settings/test-subtitles', {
        method: 'POST',
        body: candidate,
      }),
  });
}

export function useTestTmdb() {
  return useMutation({
    mutationFn: (apiKey?: string) =>
      api<{ ok: boolean; message: string }>('/settings/test-tmdb', {
        method: 'POST',
        body: apiKey ? { apiKey } : {},
      }),
  });
}
