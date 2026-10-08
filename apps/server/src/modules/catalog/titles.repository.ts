import type {
  CatalogSectionStatus,
  CatalogSort,
  MetadataStatus,
  SourceStatus,
  TitleKind,
} from '@lumiere/shared';
import { normalizeText as normalizeSearch, sortKey as sortKeyOf } from '../../core/text';
import { scalar, type Db, type SqlParams } from '../../infra/database/database';

export interface TitleRow {
  id: number;
  kind: TitleKind;
  remote_path: string;
  folder_name: string;
  is_file: number;
  parsed_title: string;
  year: number | null;
  search_text: string;
  meta_search_text: string | null;
  sort_key: string;
  remote_modified_at: string | null;
  remote_size: number | null;
  first_seen_at: string;
  last_seen_at: string;
  metadata_status: MetadataStatus;
  metadata_updated_at: string | null;
  metadata_language: string | null;
  tmdb_id: number | null;
  tmdb_title: string | null;
  original_title: string | null;
  overview: string | null;
  tagline: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  rating: number | null;
  vote_count: number | null;
  /** Indice de popularité TMDB et date de sa dernière mise à jour. */
  popularity: number | null;
  popularity_at: string | null;
  genres: string | null;
  runtime: number | null;
  release_date: string | null;
  /** `tmdb` : venu de TMDB ; `listing` : importé de la liste de l'ancienne source (site). */
  origin: 'listing' | 'tmdb';
  source_status: SourceStatus;
  source_checked_at: string | null;
  source_note: string | null;
  imdb_id: string | null;
}

/** Titre venu d'une liste ou d'une recherche TMDB. */
export interface TmdbTitleUpsert {
  kind: TitleKind;
  tmdbId: number;
  title: string;
  originalTitle: string | null;
  year: number | null;
  releaseDate: string | null;
  overview: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  rating: number | null;
  voteCount: number | null;
  popularity: number | null;
  genres: string[];
  language: string;
  /** Chemin provisoire, remplacé par le dossier virtuel du titre à la première demande. */
  remotePath: string;
  folderName: string;
}

export interface TitleMetadata {
  status: MetadataStatus;
  language: string;
  tmdbId: number | null;
  tmdbTitle: string | null;
  originalTitle: string | null;
  overview: string | null;
  tagline: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  rating: number | null;
  voteCount: number | null;
  popularity: number | null;
  genres: string[];
  runtime: number | null;
  releaseDate: string | null;
  metaSearchText: string | null;
}

export interface TitleSearch {
  kind?: TitleKind;
  tokens: string[];
  genre?: string;
  sort: CatalogSort;
  limit: number;
  offset: number;
}

/**
 * Une popularité vieille de plus de quelques jours (titre sorti des listes TMDB) passe après
 * les valeurs à jour : sinon un succès d'il y a des mois resterait en tête.
 */
const POPULARITY_FRESH_MS = 3 * 24 * 3600_000;

/** Sorties les plus récentes d'abord (les titres pas encore sortis à la fin). */
const RECENT = "release_date IS NULL, release_date > date('now'), release_date DESC, id DESC";
const POPULAR = `popularity IS NULL, (popularity_at >= @fresh) DESC, popularity DESC, ${RECENT}`;

const ORDER_BY: Record<CatalogSort, string> = {
  popular: POPULAR,
  recent: RECENT,
  title: 'sort_key ASC, year DESC',
  year: 'year IS NULL, year DESC, sort_key ASC',
  rating: 'rating IS NULL, rating DESC, vote_count DESC, sort_key ASC',
};

function freshSince(): string {
  return new Date(Date.now() - POPULARITY_FRESH_MS).toISOString();
}

export class TitlesRepository {
  constructor(private readonly db: Db) {}

  findById(id: number): TitleRow | undefined {
    return this.db.prepare('SELECT * FROM titles WHERE id = ?').get(id) as TitleRow | undefined;
  }

  findByIds(ids: number[]): TitleRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db
      .prepare(`SELECT * FROM titles WHERE id IN (${placeholders})`)
      .all(...ids) as TitleRow[];
  }

  findByFolderName(kind: TitleKind, folderName: string): TitleRow | undefined {
    return this.db
      .prepare('SELECT * FROM titles WHERE kind = ? AND folder_name = ? LIMIT 1')
      .get(kind, folderName) as TitleRow | undefined;
  }

  /** Titre (dossier de film/série) contenant un chemin distant donné. */
  findContaining(remotePath: string): TitleRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM titles
         WHERE substr(?, 1, length(remote_path)) = remote_path
         ORDER BY length(remote_path) DESC LIMIT 1`,
      )
      .get(remotePath) as TitleRow | undefined;
  }

  findByTmdbId(kind: TitleKind, tmdbId: number): TitleRow | undefined {
    return this.db
      .prepare('SELECT * FROM titles WHERE kind = ? AND tmdb_id = ? ORDER BY origin = ? LIMIT 1')
      .get(kind, tmdbId, 'tmdb') as TitleRow | undefined;
  }

  findByRemotePath(remotePath: string): TitleRow | undefined {
    return this.db.prepare('SELECT * FROM titles WHERE remote_path = ?').get(remotePath) as
      TitleRow | undefined;
  }

  count(kind: TitleKind): number {
    return scalar<number>(this.db, 'SELECT COUNT(*) FROM titles WHERE kind = ?', kind);
  }

  /**
   * Ajoute un titre venu de TMDB, ou actualise ses informations s'il est déjà connu.
   * Renvoie son identifiant (null si le dossier supposé appartient déjà à un autre titre).
   */
  upsertTmdb(item: TmdbTitleUpsert): number | null {
    const now = new Date().toISOString();
    const existing = this.findByTmdbId(item.kind, item.tmdbId);
    const searchText = normalizeSearch(`${item.title} ${item.originalTitle ?? ''}`);
    const params = {
      title: item.title,
      originalTitle: item.originalTitle,
      year: item.year,
      releaseDate: item.releaseDate,
      overview: item.overview,
      posterPath: item.posterPath,
      backdropPath: item.backdropPath,
      rating: item.rating,
      voteCount: item.voteCount,
      popularity: item.popularity,
      genres: JSON.stringify(item.genres),
      searchText,
      now,
    };
    if (existing) {
      // Informations des listes TMDB : sans écraser le dossier trouvé ni les détails complets.
      this.db
        .prepare(
          `UPDATE titles SET
             tmdb_title = COALESCE(tmdb_title, @title), original_title = COALESCE(original_title, @originalTitle),
             overview = COALESCE(overview, @overview), poster_path = COALESCE(poster_path, @posterPath),
             backdrop_path = COALESCE(backdrop_path, @backdropPath), rating = @rating, vote_count = @voteCount,
             meta_search_text = COALESCE(meta_search_text, @searchText), last_seen_at = @now,
             popularity = COALESCE(@popularity, popularity),
             popularity_at = CASE WHEN @popularity IS NULL THEN popularity_at ELSE @now END
           WHERE id = @id`,
        )
        // Seulement les paramètres de la requête : SQLite refuse les paramètres nommés inconnus
        // (année, genres…), et l'actualisation des titres déjà connus échouait.
        .run({
          id: existing.id,
          title: params.title,
          originalTitle: params.originalTitle,
          overview: params.overview,
          posterPath: params.posterPath,
          backdropPath: params.backdropPath,
          rating: params.rating,
          voteCount: params.voteCount,
          popularity: params.popularity,
          searchText: params.searchText,
          now: params.now,
        });
      return existing.id;
    }
    const result = this.db
      .prepare(
        `INSERT INTO titles (kind, remote_path, folder_name, is_file, parsed_title, year, search_text,
                             meta_search_text, sort_key, remote_modified_at, first_seen_at, last_seen_at,
                             metadata_status, metadata_language, metadata_updated_at, tmdb_id, tmdb_title,
                             original_title, overview, poster_path, backdrop_path, rating, vote_count, genres,
                             release_date, origin, source_status, popularity, popularity_at)
         VALUES (@kind, @remotePath, @folderName, 0, @title, @year, @searchText, @searchText, @sortKey,
                 @releaseDate, @now, @now, 'pending', @language, @now, @tmdbId, @title, @originalTitle,
                 @overview, @posterPath, @backdropPath, @rating, @voteCount, @genres, @releaseDate,
                 'tmdb', 'unknown', @popularity, CASE WHEN @popularity IS NULL THEN NULL ELSE @now END)
         ON CONFLICT (remote_path) DO NOTHING`,
      )
      .run({
        ...params,
        kind: item.kind,
        remotePath: item.remotePath,
        folderName: item.folderName,
        sortKey: sortKeyOf(item.title),
        language: item.language,
        tmdbId: item.tmdbId,
      });
    return result.changes > 0 ? Number(result.lastInsertRowid) : null;
  }

  setImdbId(id: number, imdbId: string): void {
    this.db.prepare('UPDATE titles SET imdb_id = ? WHERE id = ?').run(imdbId, id);
  }

  /** Présence du titre chez les extensions, et son dossier virtuel. */
  setSource(
    id: number,
    update: {
      status: SourceStatus;
      remotePath?: string;
      folderName?: string;
      note?: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE titles SET source_status = @status, source_checked_at = @checkedAt, source_note = @note,
           remote_path = COALESCE(@remotePath, remote_path), folder_name = COALESCE(@folderName, folder_name)
         WHERE id = @id`,
      )
      .run({
        id,
        status: update.status,
        checkedAt: new Date().toISOString(),
        note: update.note ?? null,
        remotePath: update.remotePath ?? null,
        folderName: update.folderName ?? null,
      });
  }

  search(query: TitleSearch): { rows: TitleRow[]; total: number } {
    const where: string[] = [];
    const params: SqlParams = {};
    if (query.kind) {
      where.push('kind = @kind');
      params.kind = query.kind;
    }
    query.tokens.forEach((token, index) => {
      where.push(`(search_text || ' ' || COALESCE(meta_search_text, '')) LIKE @t${index}`);
      params[`t${index}`] = `%${token}%`;
    });
    if (query.genre) {
      where.push('EXISTS (SELECT 1 FROM json_each(titles.genres) WHERE json_each.value = @genre)');
      params.genre = query.genre;
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const counted = this.db.prepare(`SELECT COUNT(*) AS n FROM titles ${whereSql}`).get(params) as {
      n: number;
    };
    const order = query.sort === 'popular' ? { fresh: freshSince() } : {};
    const rows = this.db
      .prepare(
        `SELECT * FROM titles ${whereSql} ORDER BY ${ORDER_BY[query.sort]} LIMIT @limit OFFSET @offset`,
      )
      .all({
        ...params,
        ...order,
        limit: query.limit,
        offset: query.offset,
      }) as unknown as TitleRow[];
    const total = counted.n;
    return { rows, total };
  }

  /** Titres les plus populaires d'après TMDB (seulement ceux dont la popularité est connue). */
  popular(kind: TitleKind, limit: number): TitleRow[] {
    return this.db
      .prepare(
        `SELECT * FROM titles WHERE kind = @kind AND popularity IS NOT NULL ORDER BY ${POPULAR} LIMIT @limit`,
      )
      .all({ kind, limit, fresh: freshSince() }) as unknown as TitleRow[];
  }

  /**
   * Mise en avant de l'accueil : titres disposant d'une image de fond et d'un résumé, les plus
   * populaires d'abord (les plus récents sans données de popularité).
   */
  featured(limit: number): TitleRow[] {
    return this.db
      .prepare(
        `SELECT * FROM titles WHERE backdrop_path IS NOT NULL AND overview IS NOT NULL
         ORDER BY ${POPULAR} LIMIT @limit`,
      )
      .all({ limit, fresh: freshSince() }) as unknown as TitleRow[];
  }

  /** Au moins un titre de la section a-t-il une popularité TMDB ? */
  hasPopularity(kind: TitleKind): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM titles WHERE kind = ? AND popularity IS NOT NULL LIMIT 1')
        .get(kind) !== undefined
    );
  }

  /** Popularité actuelle d'un titre déjà connu ; renvoie le nombre de titres mis à jour. */
  setPopularity(kind: TitleKind, tmdbId: number, popularity: number): number {
    return Number(
      this.db
        .prepare(
          'UPDATE titles SET popularity = ?, popularity_at = ? WHERE kind = ? AND tmdb_id = ?',
        )
        .run(popularity, new Date().toISOString(), kind, tmdbId).changes,
    );
  }

  genres(kind?: TitleKind): Array<{ name: string; count: number }> {
    return this.db
      .prepare(
        `SELECT json_each.value AS name, COUNT(*) AS count
         FROM titles, json_each(titles.genres)
         ${kind ? 'WHERE titles.kind = ?' : ''}
         GROUP BY json_each.value ORDER BY count DESC, name ASC`,
      )
      .all(...(kind ? [kind] : [])) as Array<{ name: string; count: number }>;
  }

  updateMetadata(id: number, metadata: TitleMetadata): void {
    this.db
      .prepare(
        `UPDATE titles SET
           metadata_status = @status, metadata_language = @language, metadata_updated_at = @updatedAt,
           tmdb_id = @tmdbId, tmdb_title = @tmdbTitle, original_title = @originalTitle, overview = @overview,
           tagline = @tagline, poster_path = @posterPath, backdrop_path = @backdropPath, rating = @rating,
           vote_count = @voteCount, genres = @genres, runtime = @runtime, release_date = @releaseDate,
           meta_search_text = @metaSearchText,
           popularity = COALESCE(@popularity, popularity),
           popularity_at = CASE WHEN @popularity IS NULL THEN popularity_at ELSE @updatedAt END
         WHERE id = @id`,
      )
      .run({
        ...(metadata as unknown as SqlParams),
        id,
        genres: JSON.stringify(metadata.genres),
        updatedAt: new Date().toISOString(),
      });
  }

  setMetadataStatus(id: number, status: MetadataStatus, language: string | null): void {
    this.db
      .prepare(
        'UPDATE titles SET metadata_status = ?, metadata_language = ?, metadata_updated_at = ? WHERE id = ?',
      )
      .run(status, language, new Date().toISOString(), id);
  }

  /** Titres à enrichir en priorité (les plus récents d'abord). */
  pendingMetadata(limit: number, retryErrorsBefore: string): TitleRow[] {
    return this.db
      .prepare(
        `SELECT * FROM titles
         WHERE metadata_status = 'pending'
            OR (metadata_status = 'error' AND metadata_updated_at < ?)
         ORDER BY COALESCE(remote_modified_at, first_seen_at) DESC, id DESC LIMIT ?`,
      )
      .all(retryErrorsBefore, limit) as TitleRow[];
  }

  /** Remet les titres en attente d'enrichissement (changement de langue ou de clé TMDB). */
  resetMetadata(): void {
    this.db
      .prepare(`UPDATE titles SET metadata_status = 'pending' WHERE metadata_status != 'pending'`)
      .run();
  }

  libraryCounts(ids: number[]): Map<number, number> {
    const counts = new Map<number, number>();
    if (ids.length === 0) return counts;
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT title_id, COUNT(*) AS count FROM library_items WHERE title_id IN (${placeholders}) GROUP BY title_id`,
      )
      .all(...ids) as Array<{ title_id: number; count: number }>;
    for (const row of rows) counts.set(row.title_id, row.count);
    return counts;
  }
}

interface SectionRow {
  kind: TitleKind;
  state: CatalogSectionStatus['state'];
  item_count: number;
  last_refresh_at: string | null;
  last_error: string | null;
}

export class CatalogSectionsRepository {
  constructor(private readonly db: Db) {}

  get(kind: TitleKind): CatalogSectionStatus {
    const row = this.db.prepare('SELECT * FROM catalog_sections WHERE kind = ?').get(kind) as
      SectionRow | undefined;
    return {
      kind,
      state: row?.state ?? 'idle',
      count: row?.item_count ?? 0,
      lastRefreshAt: row?.last_refresh_at ?? null,
      lastError: row?.last_error ?? null,
    };
  }

  save(status: CatalogSectionStatus): void {
    // Colonnes path, mode et note : héritées de l'ancienne source (site), plus utilisées.
    this.db
      .prepare(
        `INSERT INTO catalog_sections (kind, path, state, item_count, last_refresh_at, last_error, mode, note)
         VALUES (@kind, '', @state, @count, @lastRefreshAt, @lastError, 'tmdb', NULL)
         ON CONFLICT (kind) DO UPDATE SET state = excluded.state, item_count = excluded.item_count,
           last_refresh_at = excluded.last_refresh_at, last_error = excluded.last_error`,
      )
      .run({
        kind: status.kind,
        state: status.state,
        count: status.count,
        lastRefreshAt: status.lastRefreshAt,
        lastError: status.lastError,
      });
  }

  /** Au démarrage, un rafraîchissement interrompu ne doit pas rester « en cours ». */
  resetInterrupted(): void {
    this.db.prepare(`UPDATE catalog_sections SET state = 'idle' WHERE state = 'refreshing'`).run();
  }
}
