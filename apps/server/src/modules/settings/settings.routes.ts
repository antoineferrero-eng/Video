import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { AddonTestResult } from '@lumiere/shared';
import { z } from 'zod';
import type { Container } from '../../container';
import { errorMessage } from '../../core/errors';
import { TmdbClient } from '../metadata/tmdb.client';
import { normalizeAddonUrl } from '../source/stremio/stremio-addon';

const TYPE_LABELS: Record<string, string> = { movie: 'films', series: 'séries' };

function manifestUrlOf(input: string): string {
  try {
    return normalizeAddonUrl(input);
  } catch {
    return input;
  }
}

const LanguageCode = z
  .string()
  .regex(/^([a-z]{2})?$/, 'Code langue ISO 639-1 attendu (ex. « fr »)');

const SettingsUpdateSchema = z
  .object({
    sourceBaseUrl: z.url({ protocol: /^https?$/ }),
    moviesPath: z.string().min(1).max(500),
    seriesPath: z.string().min(1).max(500),
    userAgent: z.string().max(500),
    sourceConnection: z.enum(['auto', 'standard', 'browser']),
    stremioAddonUrl: z.string().max(2000),
    downloadDir: z.string().min(1).max(1000),
    maxConcurrentDownloads: z.number().int().min(1).max(10),
    maxDownloadSpeedKbps: z.number().int().min(0).max(10_000_000),
    preferredQuality: z.enum(['2160p', '1080p', '720p', 'smallest']),
    metadataLanguage: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/, 'Format attendu : fr-FR'),
    preferredAudioLanguage: LanguageCode,
    preferredSubtitleLanguage: LanguageCode,
    catalogRefreshHours: z.number().int().min(0).max(720),
    catalogSource: z.enum(['auto', 'listing', 'tmdb']),
    transcodePreset: z.enum(['quality', 'balanced', 'fast']),
    maxTranscodeHeight: z.union([
      z.literal(2160),
      z.literal(1440),
      z.literal(1080),
      z.literal(720),
      z.literal(480),
    ]),
    tmdbApiKey: z.string().max(500),
  })
  .partial()
  .strict();

export function registerSettingsRoutes(server: FastifyInstance, container: Container): void {
  const { settings, explorer, config, addon } = container;
  const app = server.withTypeProvider<ZodTypeProvider>();

  app.get('/settings', async () => settings.toResponse());

  app.patch('/settings', { schema: { body: SettingsUpdateSchema } }, async (request) => {
    await settings.update(request.body);
    return settings.toResponse();
  });

  app.post(
    '/settings/test-source',
    { schema: { body: z.object({ path: z.string().max(2000).optional() }).optional() } },
    async (request) => explorer.test(request.body?.path ?? '/'),
  );

  app.post(
    '/settings/test-addon',
    { schema: { body: z.object({ url: z.string().max(2000).optional() }).optional() } },
    async (request): Promise<AddonTestResult> => {
      const input = request.body?.url?.trim() || settings.get().stremioAddonUrl;
      const failure = (message: string): AddonTestResult => ({
        ok: false,
        manifestUrl: input ? manifestUrlOf(input) : '',
        name: null,
        version: null,
        types: [],
        message,
      });
      if (!input) return failure('Aucune extension configurée.');
      try {
        const { manifestUrl, manifest } = await addon.inspect(input);
        const streams = manifest.resources.some(
          (resource) => (typeof resource === 'string' ? resource : resource.name) === 'stream',
        );
        const types = manifest.types.filter((type) => type in TYPE_LABELS);
        const result = {
          manifestUrl,
          name: manifest.name,
          version: manifest.version,
          types: manifest.types,
        };
        if (manifest.behaviorHints?.configurationRequired) {
          return {
            ...result,
            ok: false,
            message:
              'Cette extension doit d’abord être configurée : ouvrez sa page de configuration et collez ici le lien d’installation obtenu.',
          };
        }
        if (!streams || types.length === 0) {
          return {
            ...result,
            ok: false,
            message: 'Cette extension ne fournit pas de liens de films ou de séries.',
          };
        }
        return {
          ...result,
          ok: true,
          message: `${manifest.name} ${manifest.version} : liens de ${types.map((type) => TYPE_LABELS[type]).join(' et de ')}.`,
        };
      } catch (error) {
        return failure(errorMessage(error));
      }
    },
  );

  app.post(
    '/settings/test-tmdb',
    { schema: { body: z.object({ apiKey: z.string().max(500).optional() }).optional() } },
    async (request) => {
      const key = request.body?.apiKey?.trim() || settings.getTmdbApiKey();
      if (!key) return { ok: false, message: 'Aucune clé fournie.' };
      try {
        const ok = await new TmdbClient(() => key, config.tmdb.apiBaseUrl).validateKey();
        return { ok, message: ok ? 'Clé valide.' : 'Clé refusée par TMDB.' };
      } catch (error) {
        return { ok: false, message: errorMessage(error) };
      }
    },
  );
}
