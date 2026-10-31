import type { EnqueueResult, OneFichierFileInfo, OneFichierLinkRequest } from '@lumiere/shared';
import { BadRequestError, errorMessage } from '../../core/errors';
import { isArchiveName, type ArchiveEntries } from '../archives/archive-entries';
import type { OneFichierFiles } from '../source/onefichier/onefichier-files';
import type { SourceClient } from '../source/source-client';
import type { DownloadManager } from './download-manager';

/**
 * Liens 1fichier obtenus sur une source personnalisée : vérification (nom, taille, contenu
 * d'une archive zip), puis ajout à la file. Une archive dont les vidéos sont stockées sans
 * compression est téléchargée vidéo par vidéo (chacune lue directement dans l'archive) ; une
 * archive compressée est téléchargée en entier, puis décompressée.
 */
export class LinkImports {
  constructor(
    private readonly files: OneFichierFiles,
    private readonly archives: ArchiveEntries,
    private readonly source: SourceClient,
    private readonly downloads: DownloadManager,
  ) {}

  async inspect(url: string, password?: string): Promise<OneFichierFileInfo> {
    const file = await this.files.add(url, password);
    if (!isArchiveName(file.fileName)) return { ...file, archive: null, archiveError: null };
    try {
      const archive = await this.archives.inspect(file.path, (options) =>
        this.source.openFile(file.path, options),
      );
      return { ...file, archive, archiveError: null };
    } catch (error) {
      return { ...file, archive: null, archiveError: errorMessage(error) };
    }
  }

  async enqueue(request: OneFichierLinkRequest): Promise<EnqueueResult> {
    const file = await this.inspect(request.url, request.password);
    const titleId = request.titleId ?? null;
    const season = request.season ?? null;
    if (file.archive?.streamable) {
      const wanted = request.entries ? new Set(request.entries) : null;
      const entries = file.archive.entries.filter((entry) => !wanted || wanted.has(entry.path));
      if (entries.length === 0) throw new BadRequestError('Aucune vidéo choisie dans l’archive.');
      return this.downloads.enqueueFiles(
        entries.map((entry) => ({ path: entry.path, size: entry.size, titleId, season })),
      );
    }
    // Fichier seul, ou archive compressée (décompressée une fois téléchargée).
    return this.downloads.enqueueFiles([{ path: file.path, size: file.size, titleId, season }]);
  }
}
