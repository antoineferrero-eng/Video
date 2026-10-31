import type { OneFichierFileInfo } from '@lumiere/shared';
import { InFlight } from '../../../core/async';
import { BadRequestError, NotFoundError } from '../../../core/errors';
import type { Logger } from '../../../core/logger';
import type { Db } from '../../../infra/database/database';
import { safeFileName } from '../stremio/virtual-path';
import type { AddonLink } from '../stremio/stremio-addon';
import {
  findOneFichierUrl,
  oneFichierPath,
  parseOneFichierPath,
  type OneFichierLink,
} from './onefichier-link';
import type { OneFichierClient } from './onefichier.client';

/**
 * Durée d'utilisation d'un lien direct : 1fichier le garde valable 5 minutes ; au-delà, un
 * nouveau est demandé (les connexions déjà ouvertes continuent).
 */
const DIRECT_LINK_TTL_MS = 4 * 60_000;

/** Fichier vérifié auprès de l'API (sans le contenu d'une archive, lu à part). */
export type OneFichierFile = Omit<OneFichierFileInfo, 'archive' | 'archiveError'>;

interface FileRow {
  file_id: string;
  url: string;
  password: string | null;
  file_name: string;
  size: number | null;
}

/**
 * Fichiers 1fichier ajoutés depuis une source personnalisée : lien et mot de passe gardés en
 * base, lien direct demandé à l'API (compte premium) au moment de lire les octets.
 */
export class OneFichierFiles {
  private readonly directLinks = new Map<string, { url: string; expiresAt: number }>();
  private readonly pending = new InFlight<string, string>();

  constructor(
    private readonly db: Db,
    private readonly client: OneFichierClient,
    private readonly logger: Logger,
  ) {}

  /**
   * Vérifie un lien auprès de l'API (nom, taille ; mot de passe s'il en faut un) et le garde :
   * le fichier obtient son chemin dans Lumière.
   */
  async add(input: string, password?: string | null): Promise<OneFichierFile> {
    const link = findOneFichierUrl(input);
    if (!link) {
      throw new BadRequestError(
        'Aucun lien 1fichier reconnu (forme attendue : https://1fichier.com/?identifiant).',
      );
    }
    const pass = password?.trim() || this.find(link.fileId)?.password || null;
    const details = await this.client.fileInfo(link.url, pass);
    const fileName = safeFileName(details.fileName ?? `${link.fileId}.mkv`);
    this.save(link, pass, fileName, details.size, details.checksum);
    return {
      url: link.url,
      fileName,
      size: details.size,
      path: oneFichierPath(link.fileId, fileName),
    };
  }

  /** Lien direct du fichier (le même pendant quelques minutes, sauf si `refresh`). */
  async links(path: string, options: { refresh?: boolean } = {}): Promise<AddonLink[]> {
    const ref = parseOneFichierPath(path);
    const row = ref && this.find(ref.fileId);
    if (!row) throw new NotFoundError(`Fichier 1fichier inconnu : ${path}`);
    const cached = this.directLinks.get(row.file_id);
    if (cached && cached.expiresAt > Date.now() && !options.refresh) {
      return [{ url: cached.url, headers: {}, addon: '1fichier' }];
    }
    const url = await this.pending.run(row.file_id, async () => {
      const direct = await this.client.downloadUrl(row.url, row.password);
      this.directLinks.set(row.file_id, {
        url: direct,
        expiresAt: Date.now() + DIRECT_LINK_TTL_MS,
      });
      this.logger.debug({ fileId: row.file_id }, 'Lien direct 1fichier obtenu');
      return direct;
    });
    return [{ url, headers: {}, addon: '1fichier' }];
  }

  private find(fileId: string): FileRow | undefined {
    return this.db
      .prepare(
        'SELECT file_id, url, password, file_name, size FROM onefichier_files WHERE file_id = ?',
      )
      .get(fileId) as FileRow | undefined;
  }

  private save(
    link: OneFichierLink,
    password: string | null,
    fileName: string,
    size: number | null,
    checksum: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO onefichier_files (file_id, url, password, file_name, size, checksum, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (file_id) DO UPDATE SET url = excluded.url, password = excluded.password,
           file_name = excluded.file_name, size = excluded.size, checksum = excluded.checksum`,
      )
      .run(link.fileId, link.url, password, fileName, size, checksum, new Date().toISOString());
  }
}
