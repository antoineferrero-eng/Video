export interface Migration {
  id: number;
  name: string;
  sql: string;
}

/**
 * Migrations SQL versionnées, appliquées dans l'ordre au démarrage.
 * Ne jamais modifier une migration publiée : en ajouter une nouvelle.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'schema-initial',
    sql: /* sql */ `
      CREATE TABLE settings (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE titles (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        kind                TEXT NOT NULL CHECK (kind IN ('movie', 'series')),
        remote_path         TEXT NOT NULL UNIQUE,
        folder_name         TEXT NOT NULL,
        is_file             INTEGER NOT NULL DEFAULT 0,
        parsed_title        TEXT NOT NULL,
        year                INTEGER,
        search_text         TEXT NOT NULL,
        meta_search_text    TEXT,
        sort_key            TEXT NOT NULL,
        remote_modified_at  TEXT,
        remote_size         INTEGER,
        first_seen_at       TEXT NOT NULL,
        last_seen_at        TEXT NOT NULL,
        metadata_status     TEXT NOT NULL DEFAULT 'pending',
        metadata_updated_at TEXT,
        metadata_language   TEXT,
        tmdb_id             INTEGER,
        tmdb_title          TEXT,
        original_title      TEXT,
        overview            TEXT,
        tagline             TEXT,
        poster_path         TEXT,
        backdrop_path       TEXT,
        rating              REAL,
        vote_count          INTEGER,
        genres              TEXT,
        runtime             INTEGER,
        release_date        TEXT
      );
      CREATE INDEX idx_titles_kind_added ON titles (kind, COALESCE(remote_modified_at, first_seen_at));
      CREATE INDEX idx_titles_kind_sort ON titles (kind, sort_key);
      CREATE INDEX idx_titles_metadata ON titles (metadata_status);

      CREATE TABLE catalog_sections (
        kind             TEXT PRIMARY KEY,
        path             TEXT NOT NULL,
        state            TEXT NOT NULL DEFAULT 'idle',
        item_count       INTEGER NOT NULL DEFAULT 0,
        last_refresh_at  TEXT,
        last_error       TEXT
      );

      CREATE TABLE library_items (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        kind         TEXT NOT NULL CHECK (kind IN ('movie', 'episode', 'other')),
        title_id     INTEGER REFERENCES titles (id) ON DELETE SET NULL,
        title        TEXT NOT NULL,
        season       INTEGER,
        episode      INTEGER,
        year         INTEGER,
        file_path    TEXT NOT NULL UNIQUE,
        file_name    TEXT NOT NULL,
        size_bytes   INTEGER NOT NULL,
        remote_path  TEXT,
        added_at     TEXT NOT NULL
      );
      CREATE INDEX idx_library_remote ON library_items (remote_path);
      CREATE INDEX idx_library_title ON library_items (title_id);

      CREATE TABLE downloads (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        kind              TEXT NOT NULL CHECK (kind IN ('movie', 'episode', 'file')),
        status            TEXT NOT NULL,
        title_id          INTEGER REFERENCES titles (id) ON DELETE SET NULL,
        title             TEXT NOT NULL,
        subtitle          TEXT,
        season            INTEGER,
        episode           INTEGER,
        year              INTEGER,
        remote_path       TEXT NOT NULL,
        file_name         TEXT NOT NULL,
        target_path       TEXT NOT NULL,
        total_bytes       INTEGER,
        downloaded_bytes  INTEGER NOT NULL DEFAULT 0,
        attempts          INTEGER NOT NULL DEFAULT 0,
        error             TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        started_at        TEXT,
        completed_at      TEXT,
        library_item_id   INTEGER REFERENCES library_items (id) ON DELETE SET NULL
      );
      CREATE INDEX idx_downloads_status ON downloads (status);
      CREATE INDEX idx_downloads_remote ON downloads (remote_path);

      CREATE TABLE watch_progress (
        media_key        TEXT PRIMARY KEY,
        title_id         INTEGER REFERENCES titles (id) ON DELETE SET NULL,
        library_item_id  INTEGER REFERENCES library_items (id) ON DELETE SET NULL,
        remote_path      TEXT,
        title            TEXT NOT NULL,
        subtitle         TEXT,
        position         REAL NOT NULL,
        duration         REAL,
        completed        INTEGER NOT NULL DEFAULT 0,
        updated_at       TEXT NOT NULL
      );
      CREATE INDEX idx_progress_updated ON watch_progress (updated_at);

      CREATE TABLE kv_cache (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        expires_at  INTEGER NOT NULL
      );
    `,
  },
  {
    id: 2,
    name: 'catalogue-tmdb',
    sql: /* sql */ `
      -- Titres venus de TMDB : leur dossier est cherché sur la source à l'ouverture.
      ALTER TABLE titles ADD COLUMN origin TEXT NOT NULL DEFAULT 'listing';
      ALTER TABLE titles ADD COLUMN source_status TEXT NOT NULL DEFAULT 'present';
      ALTER TABLE titles ADD COLUMN source_checked_at TEXT;
      ALTER TABLE titles ADD COLUMN source_note TEXT;
      CREATE INDEX idx_titles_tmdb ON titles (kind, tmdb_id);

      ALTER TABLE catalog_sections ADD COLUMN mode TEXT NOT NULL DEFAULT 'listing';
      ALTER TABLE catalog_sections ADD COLUMN note TEXT;
    `,
  },
  {
    id: 3,
    name: 'retrait-navigateur-zenrows',
    sql: /* sql */ `
      -- La vérification dans le navigateur et ZenRows ont été retirés : on efface la clé
      -- enregistrée et on remet les modes de connexion devenus invalides sur « auto ».
      DELETE FROM settings WHERE key = 'zenrowsApiKey';
      UPDATE settings SET value = '"auto"'
        WHERE key = 'sourceConnection' AND value IN ('"real-browser"', '"zenrows"');
    `,
  },
  {
    id: 4,
    name: 'extension-stremio',
    sql: /* sql */ `
      -- Identifiant IMDb d'un titre (demandé une fois à TMDB) : c'est lui qu'attend une
      -- extension Stremio pour fournir les liens.
      ALTER TABLE titles ADD COLUMN imdb_id TEXT;
      -- Titres TMDB jugés introuvables d'après les dossiers du site : à revérifier (par
      -- l'extension, ou par le site au prochain essai).
      UPDATE titles SET source_status = 'unknown', source_note = NULL
        WHERE origin = 'tmdb' AND source_status = 'missing';
    `,
  },
  {
    id: 5,
    name: 'popularite-tmdb',
    sql: /* sql */ `
      -- Indice de popularité TMDB (celui de la page « Populaires » du site) et date de sa
      -- dernière mise à jour : le tri par popularité place d'abord les valeurs récentes.
      ALTER TABLE titles ADD COLUMN popularity REAL;
      ALTER TABLE titles ADD COLUMN popularity_at TEXT;
      CREATE INDEX idx_titles_popularity ON titles (kind, popularity DESC);
    `,
  },
  {
    id: 6,
    name: 'extensions-stremio-seules',
    sql: /* sql */ `
      -- L'ancienne source (liste du site) est retirée : le catalogue vient de TMDB et les
      -- fichiers des extensions Stremio, désormais plusieurs (par ordre de préférence).
      INSERT INTO settings (key, value, updated_at)
        SELECT 'stremioAddonUrls', json_array(json_extract(value, '$')), updated_at
        FROM settings
        WHERE key = 'stremioAddonUrl' AND json_extract(value, '$') <> ''
      ON CONFLICT (key) DO NOTHING;
      DELETE FROM settings WHERE key IN ('stremioAddonUrl', 'sourceBaseUrl', 'moviesPath',
        'seriesPath', 'userAgent', 'sourceConnection', 'catalogSource');
      -- Titres de la liste du site que TMDB n'a pas reconnus : aucune extension ne peut les
      -- chercher (téléchargements et bibliothèque gardent leurs fichiers).
      DELETE FROM titles WHERE origin = 'listing' AND tmdb_id IS NULL;
      UPDATE titles SET source_status = 'unknown', source_note = NULL
        WHERE source_status = 'missing' AND remote_path NOT LIKE '/@stremio/%';
      -- Catalogue issu de la liste du site : réimporté depuis TMDB au prochain démarrage.
      UPDATE catalog_sections SET last_refresh_at = NULL WHERE mode <> 'addon';
    `,
  },
];
