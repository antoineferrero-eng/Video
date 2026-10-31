import path from 'node:path';
import type { ArchiveContent, ArchiveEntryInfo } from '@lumiere/shared';
import { BadRequestError, UpstreamError } from '../../core/errors';
import type { Logger } from '../../core/logger';
import { parseEpisode, parseSeasonFolder } from '../../domain/episode-parser';
import { classifyFile, isSampleFile, videoMimeType } from '../../domain/media-files';
import type { Db } from '../../infra/database/database';
import type { OpenFileOptions } from '../source/source-client';
import { safeFileName } from '../source/stremio/virtual-path';
import type { SourceResponse } from '../source/transport';
import { STORED, entryDataOffset, readZipEntries, type ReadRange, type ZipEntry } from './zip';

/** Ouvre une plage de l'archive elle-même (par le même client que les autres fichiers). */
export type OpenArchive = (options: OpenFileOptions) => Promise<SourceResponse>;

interface EntryRow {
  path: string;
  archive_path: string;
  entry_name: string;
  method: number;
  compressed_size: number;
  size: number;
  header_offset: number;
  data_offset: number | null;
  encrypted: number;
}

/** Archive reconnue d'après son nom (zip seulement). */
export function isArchiveName(name: string): boolean {
  return /\.zip$/i.test(name);
}

/**
 * Éléments des archives zip distantes (saisons complètes, par exemple) : chacun reçoit un
 * chemin dans Lumière, `<chemin de l'archive>/<fichier>`, que téléchargements, bibliothèque et
 * lecture manipulent comme un fichier ordinaire. Un élément stocké (sans compression) est lu
 * directement dans l'archive, par plages d'octets ; une archive compressée est téléchargée en
 * entier, puis décompressée.
 */
export class ArchiveEntries {
  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
  ) {}

  find(path: string): EntryRow | undefined {
    return this.db.prepare('SELECT * FROM archive_entries WHERE path = ?').get(path) as
      EntryRow | undefined;
  }

  /**
   * Contenu d'une archive distante : son répertoire est lu une fois (quelques requêtes Range
   * en fin de fichier), puis gardé en base.
   */
  async inspect(archivePath: string, open: OpenArchive): Promise<ArchiveContent> {
    let rows = this.rows(archivePath);
    if (rows.length === 0) {
      const read = rangeReader(open);
      const total = await remoteSize(open);
      const entries = await readZipEntries(read, total);
      this.save(archivePath, entries);
      rows = this.rows(archivePath);
      this.logger.info({ archive: archivePath, entries: rows.length }, 'Archive zip lue');
    }
    return describeContent(rows);
  }

  /**
   * Requête sur un élément stocké : la plage demandée est traduite en plage de l'archive, et
   * la réponse présentée comme celle du fichier seul (taille, plage, type).
   */
  async open(
    entry: EntryRow,
    options: OpenFileOptions,
    open: OpenArchive,
  ): Promise<SourceResponse> {
    if (entry.method !== STORED || entry.encrypted) {
      throw new BadRequestError(
        `${path.basename(entry.entry_name)} est compressé dans l’archive : téléchargez l’archive entière pour le décompresser.`,
      );
    }
    const dataOffset = entry.data_offset ?? (await this.locateData(entry, open));
    const size = entry.size;
    const requested = requestedRange(options, size);
    if (requested === 'unsatisfiable') return emptyResponse(416, size);
    const { start, end } = requested ?? { start: 0, end: size - 1 };
    const upstream = await open({
      start: dataOffset + start,
      end: dataOffset + end,
      method: options.method,
      signal: options.signal,
      refreshLinks: options.refreshLinks,
    });
    // Refus de l'hôte (lien expiré…) : transmis tel quel, l'appelant sait le traiter.
    if (upstream.status >= 400) return upstream;
    if (upstream.status !== 206) {
      await upstream.body?.cancel().catch(() => undefined);
      throw new UpstreamError('L’hôte ne permet pas de lire une partie de l’archive.');
    }
    const headers = new Headers(upstream.headers);
    headers.set('content-length', String(end - start + 1));
    headers.set('content-type', videoMimeType(entry.entry_name));
    headers.delete('content-disposition');
    if (requested) headers.set('content-range', `bytes ${start}-${end}/${size}`);
    else headers.delete('content-range');
    const status = requested ? 206 : 200;
    return {
      status,
      statusText: requested ? 'Partial Content' : 'OK',
      ok: true,
      url: upstream.url,
      headers,
      body: upstream.body,
      text: () => upstream.text(),
      arrayBuffer: () => upstream.arrayBuffer(),
    };
  }

  private async locateData(entry: EntryRow, open: OpenArchive): Promise<number> {
    const offset = await entryDataOffset(rangeReader(open), toZipEntry(entry));
    this.db
      .prepare('UPDATE archive_entries SET data_offset = ? WHERE path = ?')
      .run(offset, entry.path);
    return offset;
  }

  private rows(archivePath: string): EntryRow[] {
    return this.db
      .prepare('SELECT * FROM archive_entries WHERE archive_path = ? ORDER BY entry_name')
      .all(archivePath) as EntryRow[];
  }

  private save(archivePath: string, entries: ZipEntry[]): void {
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO archive_entries
         (path, archive_path, entry_name, method, compressed_size, size, header_offset, encrypted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const used = new Set<string>();
    for (const entry of entries) {
      // Chemin à plat : le nom du fichier, rendu unique si deux dossiers en ont un pareil.
      let name = safeFileName(path.posix.basename(entry.name));
      for (let index = 2; used.has(name.toLowerCase()); index += 1) {
        name = `${index}-${safeFileName(path.posix.basename(entry.name))}`;
      }
      used.add(name.toLowerCase());
      insert.run(
        `${archivePath}/${name}`,
        archivePath,
        entry.name,
        entry.method,
        entry.compressedSize,
        entry.size,
        entry.localHeaderOffset,
        entry.encrypted ? 1 : 0,
      );
    }
  }
}

/** Vidéos de l'archive (échantillons exclus), avec l'épisode lu dans leur nom. */
function describeContent(rows: EntryRow[]): ArchiveContent {
  const videos = rows.filter(
    (row) => classifyFile(row.entry_name) === 'video' && !isSampleFile(row.entry_name),
  );
  const entries: ArchiveEntryInfo[] = videos.map((row) => {
    const folder = path.posix.basename(path.posix.dirname(row.entry_name));
    const ref = parseEpisode(path.posix.basename(row.entry_name), parseSeasonFolder(folder));
    return {
      path: row.path,
      name: path.posix.basename(row.entry_name),
      size: row.size,
      season: ref.season,
      episode: ref.episode,
    };
  });
  entries.sort(
    (a, b) =>
      (a.season ?? 0) - (b.season ?? 0) ||
      (a.episode ?? 0) - (b.episode ?? 0) ||
      a.name.localeCompare(b.name),
  );
  return {
    streamable: videos.length > 0 && videos.every((row) => row.method === STORED && !row.encrypted),
    entries,
  };
}

function toZipEntry(row: EntryRow): ZipEntry {
  return {
    name: row.entry_name,
    method: row.method,
    compressedSize: row.compressed_size,
    size: row.size,
    localHeaderOffset: row.header_offset,
    encrypted: row.encrypted === 1,
  };
}

/** Lecture par plages d'une archive distante. */
function rangeReader(open: OpenArchive): ReadRange {
  return async (start, end) => {
    const response = await open({ start, end, refreshLinks: true });
    if (response.status !== 206) {
      await response.body?.cancel().catch(() => undefined);
      throw new UpstreamError(
        `Lecture de l’archive impossible (HTTP ${response.status}) : l’hôte doit accepter les plages d’octets.`,
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length !== end - start + 1) {
      throw new UpstreamError('Lecture de l’archive incomplète.');
    }
    return buffer;
  };
}

/** Taille d'une archive distante, d'après la réponse à la plage du premier octet. */
async function remoteSize(open: OpenArchive): Promise<number> {
  const response = await open({ start: 0, end: 0, refreshLinks: true });
  await response.body?.cancel().catch(() => undefined);
  const total = Number(/\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1]);
  if (response.status !== 206 || !Number.isFinite(total) || total <= 0) {
    throw new UpstreamError(
      `Taille de l’archive inconnue (HTTP ${response.status}) : l’hôte doit accepter les plages d’octets.`,
    );
  }
  return total;
}

/** Plage demandée (bornes comprises), null pour le fichier entier. */
function requestedRange(
  options: OpenFileOptions,
  size: number,
): { start: number; end: number } | null | 'unsatisfiable' {
  let raw = options.range;
  if (!raw && (options.start !== undefined || options.end !== undefined)) {
    raw = `bytes=${options.start ?? 0}-${options.end ?? ''}`;
  }
  if (!raw) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    // Suffixe : les N derniers octets.
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

function emptyResponse(status: number, size: number): SourceResponse {
  const headers = new Headers({ 'content-range': `bytes */${size}`, 'content-length': '0' });
  return {
    status,
    statusText: 'Range Not Satisfiable',
    ok: false,
    url: '',
    headers,
    body: null,
    text: async () => '',
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}
