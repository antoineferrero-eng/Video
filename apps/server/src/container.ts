import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from './config/env';
import { errorMessage } from './core/errors';
import { EventBus } from './core/event-bus';
import type { Logger } from './core/logger';
import { KeyValueCache, openDatabase, type Db } from './infra/database/database';
import { AvailabilityService } from './modules/availability/availability.service';
import { AddonCatalog } from './modules/catalog/addon-catalog';
import { CatalogService } from './modules/catalog/catalog.service';
import { TmdbCatalog } from './modules/catalog/tmdb-catalog';
import { CatalogSectionsRepository, TitlesRepository } from './modules/catalog/titles.repository';
import { DownloadManager } from './modules/downloads/download-manager';
import { DownloadsRepository } from './modules/downloads/downloads.repository';
import { LibraryRepository } from './modules/library/library.repository';
import { LibraryService } from './modules/library/library.service';
import { ImageCache } from './modules/metadata/image-cache';
import { MetadataService } from './modules/metadata/metadata.service';
import { TmdbClient } from './modules/metadata/tmdb.client';
import { OnlineSubtitlesService } from './modules/subtitles/online-subtitles.service';
import { OpenSubtitlesClient } from './modules/subtitles/opensubtitles.client';
import { SubtitleAddons } from './modules/subtitles/subtitle-addons';
import { Ffmpeg } from './modules/playback/ffmpeg';
import { PlaybackService } from './modules/playback/playback.service';
import { ProgressRepository } from './modules/playback/progress.repository';
import { PlaybackSessions } from './modules/playback/sessions';
import { SettingsService } from './modules/settings/settings.service';
import { SourceClient } from './modules/source/source-client';
import { SourceRelay } from './modules/source/source-relay';
import { StremioAddons } from './modules/source/stremio/stremio-addon';
import { virtualFolder } from './modules/source/stremio/virtual-path';

/** Racine de composition : instancie et relie tous les services (injection manuelle). */
export interface Container {
  config: AppConfig;
  logger: Logger;
  db: Db;
  events: EventBus;
  settings: SettingsService;
  addons: StremioAddons;
  source: SourceClient;
  relay: SourceRelay;
  titles: TitlesRepository;
  availability: AvailabilityService;
  tmdb: TmdbClient;
  metadata: MetadataService;
  images: ImageCache;
  catalog: CatalogService;
  library: LibraryService;
  downloads: DownloadManager;
  ffmpeg: Ffmpeg;
  playback: PlaybackService;
  sessions: PlaybackSessions;
  openSubtitles: OpenSubtitlesClient;
  subtitleAddons: SubtitleAddons;
  onlineSubtitles: OnlineSubtitlesService;
}

export function createContainer(config: AppConfig, logger: Logger): Container {
  const db = openDatabase(config.databaseFile, logger);
  const events = new EventBus();
  const settings = new SettingsService(db, config);
  const kvCache = new KeyValueCache(db);
  const titles = new TitlesRepository(db);
  const addons = new StremioAddons(settings, kvCache, logger.child({ module: 'stremio' }), {
    tmdbIdOf: (kind, id) => titles.findByRemotePath(virtualFolder(kind, id))?.tmdb_id ?? null,
  });
  const source = new SourceClient(addons, logger.child({ module: 'source' }));
  const relay = new SourceRelay(config);
  const availability = new AvailabilityService(db);
  const tmdb = new TmdbClient(() => settings.getTmdbApiKey(), config.tmdb.apiBaseUrl);
  const metadata = new MetadataService(
    titles,
    tmdb,
    settings,
    kvCache,
    events,
    logger.child({ module: 'metadata' }),
  );
  const catalogLogger = logger.child({ module: 'catalog' });
  const images = new ImageCache(path.join(config.cacheDir, 'images'), config.tmdb.imageBaseUrl);
  const catalog = new CatalogService(
    titles,
    new CatalogSectionsRepository(db),
    settings,
    metadata,
    availability,
    events,
    catalogLogger,
    new TmdbCatalog(titles, tmdb, settings, kvCache, catalogLogger),
    new AddonCatalog(titles, tmdb, metadata, addons, settings, kvCache, catalogLogger),
  );
  const library = new LibraryService(
    new LibraryRepository(db),
    titles,
    metadata,
    availability,
    settings,
    events,
    logger.child({ module: 'library' }),
  );
  const downloads = new DownloadManager(
    new DownloadsRepository(db),
    source,
    library,
    catalog,
    titles,
    metadata,
    settings,
    events,
    logger.child({ module: 'downloads' }),
  );
  const ffmpeg = new Ffmpeg(
    config.ffmpegPath,
    config.ffprobePath,
    logger.child({ module: 'ffmpeg' }),
  );
  const sessions = new PlaybackSessions();
  const subtitlesLogger = logger.child({ module: 'subtitles' });
  const openSubtitles = new OpenSubtitlesClient({
    baseUrl: config.openSubtitles.apiBaseUrl,
    apiKey: () => settings.getOpenSubtitlesApiKey(),
    credentials: () => settings.getOpenSubtitlesCredentials(),
    userAgent: `Lumiere v${config.version}`,
    logger: subtitlesLogger,
  });
  const subtitleAddons = new SubtitleAddons();
  const onlineSubtitles = new OnlineSubtitlesService(
    settings,
    titles,
    tmdb,
    openSubtitles,
    subtitleAddons,
    subtitlesLogger,
  );
  const playback = new PlaybackService(
    ffmpeg,
    sessions,
    source,
    relay,
    library,
    catalog,
    titles,
    metadata,
    new ProgressRepository(db),
    settings,
    onlineSubtitles,
    config,
    logger.child({ module: 'playback' }),
  );

  return {
    config,
    logger,
    db,
    events,
    settings,
    addons,
    source,
    relay,
    titles,
    availability,
    tmdb,
    metadata,
    images,
    catalog,
    library,
    downloads,
    ffmpeg,
    playback,
    sessions,
    openSubtitles,
    subtitleAddons,
    onlineSubtitles,
  };
}

export async function startServices(container: Container): Promise<void> {
  removeLegacyBrowserProfile(container);
  await container.ffmpeg.detect();
  container.metadata.start();
  container.downloads.start();
  container.catalog.start();
  container.library
    .scan()
    .catch((error) =>
      container.logger.warn({ err: errorMessage(error) }, 'Analyse de la bibliothèque impossible'),
    );
}

/** Profil du navigateur de l'ancienne vérification Cloudflare (fonction retirée). */
function removeLegacyBrowserProfile({ config, logger }: Container): void {
  const profile = path.join(config.dataDir, 'navigateur');
  if (!fs.existsSync(profile)) return;
  fsp
    .rm(profile, { recursive: true, force: true })
    .then(() => logger.info({ profile }, 'Ancien profil de navigateur supprimé'))
    .catch((error) =>
      logger.debug({ err: errorMessage(error) }, 'Ancien profil de navigateur non supprimé'),
    );
}

export async function stopServices(container: Container): Promise<void> {
  container.catalog.stop();
  container.metadata.stop();
  container.sessions.closeAll();
  await container.downloads.stop();
  container.db.close();
}
