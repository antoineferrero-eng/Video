import type { ExplorerEntry, ExplorerListing, SourceTestResult } from '@lumiere/shared';
import { errorMessage, type AppError } from '../../core/errors';
import { classifyFile, isSampleFile } from '../../domain/media-files';
import { parseRelease } from '../../domain/release-parser';
import type { AvailabilityService } from '../availability/availability.service';
import { normalizeDirPath, remoteParent } from '../source/remote-path';
import type { RemoteEntry, SourceClient } from '../source/source-client';

const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });

/** Navigation brute dans l'arborescence de la source (indépendante du catalogue). */
export class ExplorerService {
  constructor(
    private readonly source: SourceClient,
    private readonly availability: AvailabilityService,
  ) {}

  async list(path: string, force = false): Promise<ExplorerListing> {
    const dirPath = normalizeDirPath(path);
    const listing = await this.source.list(dirPath, { force });
    const entries: ExplorerEntry[] = listing.entries.map((entry) => toExplorerEntry(entry));
    const videos = entries.filter((entry) => entry.kind === 'video');
    const availability = this.availability.forRemotePaths(videos.map((entry) => entry.path));
    for (const entry of videos) entry.availability = availability.get(entry.path) ?? null;
    entries.sort(
      (a, b) =>
        Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
        collator.compare(a.name, b.name),
    );

    const segments = dirPath.split('/').filter(Boolean);
    const breadcrumbs = segments.map((name, index) => ({
      name,
      path: `/${segments.slice(0, index + 1).join('/')}/`,
    }));
    return {
      path: dirPath,
      parent: remoteParent(dirPath),
      breadcrumbs,
      entries,
      sourceUrl: listing.url,
      format: listing.format,
    };
  }

  /** Parcourt récursivement un dossier pour en extraire les vidéos (« télécharger le dossier »). */
  async collectVideos(
    path: string,
    options = { maxDepth: 4, maxFiles: 2000, maxDirs: 300 },
  ): Promise<RemoteEntry[]> {
    const videos: RemoteEntry[] = [];
    const queue: Array<{ path: string; depth: number }> = [
      { path: normalizeDirPath(path), depth: 0 },
    ];
    let visited = 0;
    while (queue.length > 0 && videos.length < options.maxFiles && visited < options.maxDirs) {
      const current = queue.shift() as { path: string; depth: number };
      visited += 1;
      const listing = await this.source.list(current.path);
      for (const entry of listing.entries) {
        if (entry.isDirectory) {
          if (current.depth < options.maxDepth)
            queue.push({ path: entry.path, depth: current.depth + 1 });
        } else if (classifyFile(entry.name) === 'video' && !isSampleFile(entry.name)) {
          videos.push(entry);
        }
      }
    }
    return videos.slice(0, options.maxFiles);
  }

  /** Diagnostic : la source est-elle joignable et son listing est-il compris ? */
  async test(path = '/'): Promise<SourceTestResult> {
    const started = Date.now();
    const url = this.source.urlFor(normalizeDirPath(path));
    try {
      const listing = await this.source.list(path, { force: true });
      return {
        ok: listing.entries.length > 0,
        url,
        status: 200,
        durationMs: Date.now() - started,
        format: listing.format,
        directories: listing.entries.filter((entry) => entry.isDirectory).length,
        files: listing.entries.filter((entry) => !entry.isDirectory).length,
        sample: listing.entries.slice(0, 12).map((entry) => toExplorerEntry(entry)),
        error: listing.entries.length > 0 ? null : 'Aucune entrée reconnue dans la page.',
      };
    } catch (error) {
      const upstream =
        (error as AppError & { upstreamStatus?: number | null }).upstreamStatus ?? null;
      return {
        ok: false,
        url,
        status: upstream ?? (error as AppError).statusCode ?? null,
        durationMs: Date.now() - started,
        format: null,
        directories: 0,
        files: 0,
        sample: [],
        error: errorMessage(error),
      };
    }
  }
}

function toExplorerEntry(entry: RemoteEntry): ExplorerEntry {
  const kind = entry.isDirectory ? 'directory' : classifyFile(entry.name);
  return {
    name: entry.name,
    path: entry.path,
    kind,
    size: entry.size,
    modifiedAt: entry.modifiedAt,
    release: kind === 'video' ? parseRelease(entry.name).info : null,
    availability: null,
  };
}
