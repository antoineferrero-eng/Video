import path from 'node:path';
import type { AppConfig } from './config/env';
import { errorMessage } from './core/errors';
import { EventBus } from './core/event-bus';
import type { Logger } from './core/logger';
import { KeyValueCache, openDatabase, type Db } from './infra/database/database';
import { AvailabilityService } from './modules/availability/availability.service';
import { CatalogService } from './modules/catalog/catalog.service';
import { CatalogSectionsRepository, TitlesRepository } from './modules/catalog/titles.repository';
import { DownloadManager } from './modules/downloads/download-manager';
import { DownloadsRepository } from './modules/downloads/downloads.repository';
import { ExplorerService } from './modules/explorer/explorer.service';
import { LibraryRepository } from './modules/library/library.repository';
import { LibraryService } from './modules/library/library.service';
import { ImageCache } from './modules/metadata/image-cache';
import { MetadataService } from './modules/metadata/metadata.service';
import { TmdbClient } from './modules/metadata/tmdb.client';
import { Ffmpeg } from './modules/playback/ffmpeg';
import { PlaybackService } from './modules/playback/playback.service';
import { ProgressRepository } from './modules/playback/progress.repository';
import { PlaybackSessions } from './modules/playback/sessions';
import { SettingsService } from './modules/settings/settings.service';
import { BrowserSession } from './modules/source/browser/browser-session';
import { locateBrowser } from './modules/source/browser/locate-browser';
import { RealBrowserTransport } from './modules/source/browser/real-browser-transport';
import { SourceClient } from './modules/source/source-client';
import { SourceRelay } from './modules/source/source-relay';
import { ZenRowsTransport } from './modules/source/zenrows-transport';

/** Racine de composition : instancie et relie tous les services (injection manuelle). */
export interface Container {
  config: AppConfig;
  logger: Logger;
  db: Db;
  events: EventBus;
  settings: SettingsService;
  browser: BrowserSession;
  zenrows: ZenRowsTransport;
  source: SourceClient;
  relay: SourceRelay;
  titles: TitlesRepository;
  availability: AvailabilityService;
  tmdb: TmdbClient;
  metadata: MetadataService;
  images: ImageCache;
  catalog: CatalogService;
  explorer: ExplorerService;
  library: LibraryService;
  downloads: DownloadManager;
  ffmpeg: Ffmpeg;
  playback: PlaybackService;
  sessions: PlaybackSessions;
}

export function createContainer(config: AppConfig, logger: Logger): Container {
  const db = openDatabase(config.databaseFile, logger);
  const events = new EventBus();
  const settings = new SettingsService(db, config);
  const sourceLogger = logger.child({ module: 'source' });
  const browser = new BrowserSession({
    profileDir: config.browserProfileDir,
    locate: () => locateBrowser(config.browserPath),
    logger: sourceLogger,
    onEvent: (event) => events.publish({ type: 'source.verification', ...event }),
  });
  const zenrows = new ZenRowsTransport(
    () => settings.getZenrowsApiKey(),
    config.zenrows.apiUrl,
    sourceLogger,
  );
  const source = new SourceClient(settings, sourceLogger, {
    realBrowser: (cookies) => new RealBrowserTransport(browser, cookies, sourceLogger),
    zenrows,
  });
  const relay = new SourceRelay(config);
  const titles = new TitlesRepository(db);
  const availability = new AvailabilityService(db);
  const tmdb = new TmdbClient(() => settings.getTmdbApiKey(), config.tmdb.apiBaseUrl);
  const metadata = new MetadataService(
    titles,
    tmdb,
    settings,
    new KeyValueCache(db),
    events,
    logger.child({ module: 'metadata' }),
  );
  const images = new ImageCache(path.join(config.cacheDir, 'images'), config.tmdb.imageBaseUrl);
  const catalog = new CatalogService(
    titles,
    new CatalogSectionsRepository(db),
    source,
    settings,
    metadata,
    availability,
    events,
    logger.child({ module: 'catalog' }),
  );
  const explorer = new ExplorerService(source, availability);
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
    explorer,
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
    config,
    logger.child({ module: 'playback' }),
  );

  return {
    config,
    logger,
    db,
    events,
    settings,
    browser,
    zenrows,
    source,
    relay,
    titles,
    availability,
    tmdb,
    metadata,
    images,
    catalog,
    explorer,
    library,
    downloads,
    ffmpeg,
    playback,
    sessions,
  };
}

export async function startServices(container: Container): Promise<void> {
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

export async function stopServices(container: Container): Promise<void> {
  container.catalog.stop();
  container.metadata.stop();
  container.sessions.closeAll();
  await container.downloads.stop();
  await container.browser.close();
  container.db.close();
}
