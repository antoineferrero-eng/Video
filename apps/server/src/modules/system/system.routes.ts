import type { FastifyInstance } from 'fastify';
import type { SystemInfo } from '@lumiere/shared';
import type { Container } from '../../container';
import { getDiskSpace } from '../../core/fs';

export function registerSystemRoutes(server: FastifyInstance, container: Container): void {
  const { config, settings, ffmpeg, catalog, browser, zenrows } = container;

  server.get('/health', async () => ({ status: 'ok' }));

  server.get('/system', async (): Promise<SystemInfo> => {
    const downloadDir = settings.get().downloadDir;
    return {
      version: config.version,
      nodeVersion: process.version,
      platform: `${process.platform} ${process.arch}`,
      dataDir: config.dataDir,
      downloadDir,
      disk: await getDiskSpace(downloadDir),
      ffmpeg: {
        available: ffmpeg.info.available,
        version: ffmpeg.info.version,
        ffprobeAvailable: ffmpeg.info.ffprobeAvailable,
      },
      tmdbConfigured: settings.getTmdbApiKey() !== null,
      catalog: catalog.statuses(),
      browser: browser.executable,
      zenrows: zenrows.configured ? zenrows.usage() : null,
    };
  });
}
