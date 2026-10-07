import { InFlight } from '../../core/async';
import { NotFoundError, errorMessage } from '../../core/errors';
import type { Logger } from '../../core/logger';
import { folderCandidates } from '../../domain/folder-names';
import type { TmdbClient } from '../metadata/tmdb.client';
import type { SettingsService } from '../settings/settings.service';
import { joinRemote } from '../source/remote-path';
import type { SourceClient } from '../source/source-client';
import type { TitleRow, TitlesRepository } from './titles.repository';

/** Un titre introuvable est recherché à nouveau après ce délai (il a pu être ajouté). */
const MISSING_RETRY_MS = 24 * 3600_000;

/**
 * Trouve sur la source le dossier d'un titre venu de TMDB, sans lire la liste complète :
 * les noms probables (« Titre (Année) » pour un film, « Titre » pour une série) sont
 * essayés un par un, à partir des titres anglais, original et traduit. Le résultat (dossier
 * trouvé, ou dossiers essayés) est mémorisé.
 */
export class SourceResolver {
  private readonly inflight = new InFlight<number, TitleRow>();

  constructor(
    private readonly titles: TitlesRepository,
    private readonly tmdb: TmdbClient,
    private readonly source: SourceClient,
    private readonly settings: SettingsService,
    private readonly logger: Logger,
  ) {}

  /** Titre dont le dossier est connu (ou recherché), au plus une recherche à la fois. */
  ensure(row: TitleRow): Promise<TitleRow> {
    if (row.origin !== 'tmdb' || row.source_status === 'present') return Promise.resolve(row);
    if (
      row.source_status === 'missing' &&
      row.source_checked_at &&
      Date.now() - Date.parse(row.source_checked_at) < MISSING_RETRY_MS
    ) {
      return Promise.resolve(row);
    }
    return this.inflight.run(row.id, () => this.resolve(row));
  }

  private async names(row: TitleRow): Promise<string[]> {
    const names: string[] = [];
    if (row.tmdb_id !== null) {
      try {
        // Les dossiers suivent le titre anglais de TMDB (repli sur le titre original).
        if (row.kind === 'movie') {
          const movie = await this.tmdb.movie(row.tmdb_id, 'en-US');
          names.push(movie.title, movie.original_title);
        } else {
          const show = await this.tmdb.tv(row.tmdb_id, 'en-US');
          names.push(show.name, show.original_name);
        }
      } catch (error) {
        this.logger.debug({ err: errorMessage(error) }, 'Titre anglais TMDB indisponible');
      }
    }
    names.push(row.original_title ?? '', row.tmdb_title ?? row.parsed_title);
    return names.filter(Boolean);
  }

  private async resolve(row: TitleRow): Promise<TitleRow> {
    const settings = this.settings.get();
    const section = row.kind === 'movie' ? settings.moviesPath : settings.seriesPath;
    const candidates = folderCandidates({
      kind: row.kind,
      titles: await this.names(row),
      year: row.year,
    });
    const tried: string[] = [];
    for (const folder of candidates) {
      const path = joinRemote(section, folder, true);
      tried.push(folder);
      try {
        await this.source.list(path);
      } catch (error) {
        if (error instanceof NotFoundError) continue;
        throw error;
      }
      this.logger.info(
        { title: row.tmdb_title ?? row.parsed_title, folder, attempts: tried.length },
        'Dossier trouvé sur la source',
      );
      const owner = this.titles.findByRemotePath(path);
      if (owner && owner.id !== row.id) {
        // Le dossier figure déjà au catalogue (liste de la source) : un seul titre suffit.
        this.titles.mergeInto(row.id, owner.id);
        return this.titles.findById(owner.id) ?? owner;
      }
      this.titles.setSource(row.id, { status: 'present', remotePath: path, folderName: folder });
      return this.titles.findById(row.id) ?? row;
    }
    this.logger.info(
      { title: row.tmdb_title ?? row.parsed_title, tried },
      'Titre introuvable sur la source',
    );
    this.titles.setSource(row.id, { status: 'missing', note: JSON.stringify(tried) });
    return this.titles.findById(row.id) ?? row;
  }
}
