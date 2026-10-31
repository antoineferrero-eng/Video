import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type {
  AddonTestResult,
  ApiKeyTestResult,
  SubtitleProvidersTestResult,
} from '@lumiere/shared';
import { z } from 'zod';
import type { Container } from '../../container';
import { errorMessage } from '../../core/errors';
import { TmdbClient } from '../metadata/tmdb.client';
import { normalizeAddonUrl } from '../source/stremio/stremio-addon';
import { OpenSubtitlesClient } from '../subtitles/opensubtitles.client';
import { providesSubtitles } from '../subtitles/subtitle-addons';

const TYPE_LABELS: Record<string, string> = { movie: 'films', series: 'séries' };

function manifestUrlOf(input: string): string {
  try {
    return normalizeAddonUrl(input);
  } catch {
    return input;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const LanguageCode = z
  .string()
  .regex(/^([a-z]{2})?$/, 'Code langue ISO 639-1 attendu (ex. « fr »)');

const SettingsUpdateSchema = z
  .object({
    stremioAddonUrls: z.array(z.string().max(2000)).max(10),
    downloadDir: z.string().min(1).max(1000),
    maxConcurrentDownloads: z.number().int().min(1).max(10),
    maxDownloadSpeedKbps: z.number().int().min(0).max(10_000_000),
    preferredQuality: z.enum(['2160p', '1080p', '720p', 'smallest']),
    metadataLanguage: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/, 'Format attendu : fr-FR'),
    preferredAudioLanguage: LanguageCode,
    preferredSubtitleLanguage: LanguageCode,
    subtitleAddonUrls: z.array(z.string().max(2000)).max(10),
    openSubtitlesUsername: z.string().max(200),
    customSources: z
      .array(
        z.object({
          id: z.string().max(100),
          name: z.string().max(100),
          searchUrl: z.string().max(2000),
          host: z.enum(['1fichier']),
        }),
      )
      .max(20),
    catalogRefreshHours: z.number().int().min(0).max(720),
    // TMDB ne sert pas plus de 500 pages de 20 titres.
    catalogSize: z.number().int().min(100).max(10_000),
    transcodePreset: z.enum(['quality', 'balanced', 'fast']),
    maxTranscodeHeight: z.union([
      z.literal(2160),
      z.literal(1440),
      z.literal(1080),
      z.literal(720),
      z.literal(480),
    ]),
    tmdbApiKey: z.string().max(500),
    openSubtitlesApiKey: z.string().max(500),
    openSubtitlesPassword: z.string().max(500),
    oneFichierApiKey: z.string().max(500),
  })
  .partial()
  .strict();

export function registerSettingsRoutes(server: FastifyInstance, container: Container): void {
  const { settings, config, addons, subtitleAddons, oneFichier, logger } = container;
  const app = server.withTypeProvider<ZodTypeProvider>();

  app.get('/settings', async () => settings.toResponse());

  app.patch('/settings', { schema: { body: SettingsUpdateSchema } }, async (request) => {
    await settings.update(request.body);
    return settings.toResponse();
  });

  app.post(
    '/settings/test-addon',
    { schema: { body: z.object({ url: z.string().max(2000).optional() }).optional() } },
    async (request): Promise<AddonTestResult> => {
      const input = request.body?.url?.trim() || (settings.get().stremioAddonUrls[0] ?? '');
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
        const { manifestUrl, manifest } = await addons.inspect(input);
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

  // Test des services de sous-titres en ligne, avec les valeurs saisies (pas encore enregistrées).
  app.post(
    '/settings/test-subtitles',
    {
      schema: {
        body: z
          .object({
            openSubtitlesApiKey: z.string().max(500),
            openSubtitlesUsername: z.string().max(200),
            openSubtitlesPassword: z.string().max(500),
            subtitleAddonUrls: z.array(z.string().max(2000)).max(10),
            providers: z.array(z.enum(['opensubtitles', 'addons'])).max(2),
          })
          .partial()
          .optional(),
      },
    },
    async (request): Promise<SubtitleProvidersTestResult> => {
      const body = request.body ?? {};
      const providers: SubtitleProvidersTestResult['providers'] = [];
      const tested = new Set(body.providers ?? ['opensubtitles', 'addons']);
      const apiKey = body.openSubtitlesApiKey?.trim() || settings.getOpenSubtitlesApiKey();
      if (apiKey && tested.has('opensubtitles')) {
        const username = body.openSubtitlesUsername ?? settings.get().openSubtitlesUsername;
        const saved = settings.getOpenSubtitlesCredentials();
        const password =
          body.openSubtitlesPassword ||
          (saved && saved.username === username.trim() ? saved.password : '');
        const client = new OpenSubtitlesClient({
          baseUrl: config.openSubtitles.apiBaseUrl,
          apiKey: () => apiKey,
          credentials: () =>
            username.trim() && password ? { username: username.trim(), password } : null,
          userAgent: `Lumiere v${config.version}`,
          logger,
        });
        try {
          providers.push({ name: 'OpenSubtitles.com', ok: true, message: await client.test() });
        } catch (error) {
          providers.push({ name: 'OpenSubtitles.com', ok: false, message: errorMessage(error) });
        }
      }
      const addonUrls = tested.has('addons')
        ? (body.subtitleAddonUrls ?? settings.get().subtitleAddonUrls)
        : [];
      for (const input of addonUrls) {
        if (!input.trim()) continue;
        const url = manifestUrlOf(input);
        try {
          const manifest = await subtitleAddons.manifest(url);
          const kinds = (['movie', 'series'] as const).filter((kind) =>
            providesSubtitles(manifest, kind, 'tt0000001'),
          );
          providers.push({
            name: manifest.name,
            ok: kinds.length > 0,
            message:
              kinds.length > 0
                ? `${manifest.name} ${manifest.version} : sous-titres de ${kinds.map((kind) => TYPE_LABELS[kind]).join(' et de ')}.`
                : 'Cette extension ne fournit pas de sous-titres de films ou de séries.',
          });
        } catch (error) {
          providers.push({ name: hostOf(url), ok: false, message: errorMessage(error) });
        }
      }
      return { providers };
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

  // Test de la clé 1fichier (saisie, ou enregistrée) : le lien direct exige un compte premium.
  app.post(
    '/settings/test-onefichier',
    { schema: { body: z.object({ apiKey: z.string().max(500).optional() }).optional() } },
    async (request): Promise<ApiKeyTestResult> => {
      const key = request.body?.apiKey?.trim() || settings.getOneFichierApiKey();
      if (!key) return { ok: false, message: 'Aucune clé fournie.' };
      try {
        const account = await oneFichier.account(key);
        if (!account.offer) {
          // Valeurs reçues affichées : une offre que Lumière ne connaît pas se repère ainsi.
          const received = `offre : ${JSON.stringify(account.rawOffer ?? null)}, fin d’abonnement : ${account.subscriptionEnd ?? 'aucune'}`;
          return {
            ok: false,
            message: `Clé valide, mais 1fichier n’indique pas d’abonnement premium pour ce compte (${received}). Si votre compte est premium, essayez un téléchargement : c’est lui qui fait foi.`,
          };
        }
        const until = account.subscriptionEnd
          ? `, jusqu’au ${account.subscriptionEnd.slice(0, 10)}`
          : '';
        return { ok: true, message: `Compte ${account.offer}${until}.` };
      } catch (error) {
        return { ok: false, message: errorMessage(error) };
      }
    },
  );
}
