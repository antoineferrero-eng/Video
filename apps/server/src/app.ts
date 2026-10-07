import fs from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
} from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { ApiErrorBody } from '@lumiere/shared';
import type { Container } from './container';
import { AppError } from './core/errors';
import { registerCatalogRoutes } from './modules/catalog/catalog.routes';
import { registerDownloadRoutes } from './modules/downloads/downloads.routes';
import { registerEventRoutes } from './modules/events/events.routes';
import { registerExplorerRoutes } from './modules/explorer/explorer.routes';
import { registerLibraryRoutes } from './modules/library/library.routes';
import { registerMetadataRoutes } from './modules/metadata/metadata.routes';
import { registerPlaybackRoutes } from './modules/playback/playback.routes';
import { registerSettingsRoutes } from './modules/settings/settings.routes';
import { registerSourceRoutes } from './modules/source/source.routes';
import { registerSystemRoutes } from './modules/system/system.routes';

export async function buildApp(container: Container): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: container.logger as FastifyBaseLogger,
    // Journal des requêtes géré par le hook onResponse ci-dessous (plus concis).
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 2 * 1024 * 1024,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode >= 500) {
      request.log.warn(
        { method: request.method, url: request.url, status: reply.statusCode },
        'Requête en erreur',
      );
    } else {
      request.log.debug(
        {
          method: request.method,
          url: request.url,
          status: reply.statusCode,
          ms: Math.round(reply.elapsedTime),
        },
        'Requête',
      );
    }
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    let status = 500;
    let body: ApiErrorBody;
    if (hasZodFastifySchemaValidationErrors(error)) {
      status = 400;
      body = {
        error: 'VALIDATION_ERROR',
        message: 'Requête invalide.',
        details: error.validation.map((issue) => ({
          path: issue.instancePath,
          message: issue.message,
        })),
      };
    } else if (error instanceof AppError) {
      status = error.statusCode;
      body = { error: error.code, message: error.message, details: error.details };
    } else if (error.statusCode && error.statusCode < 500) {
      status = error.statusCode;
      body = { error: error.code ?? 'REQUEST_ERROR', message: error.message };
    } else {
      request.log.error({ err: error }, 'Erreur inattendue');
      body = { error: 'INTERNAL_ERROR', message: 'Une erreur interne est survenue.' };
    }
    if (reply.sent || reply.raw.headersSent) return;
    return reply.code(status).send(body);
  });

  await app.register(
    async (api) => {
      registerSystemRoutes(api, container);
      registerEventRoutes(api, container);
      registerSettingsRoutes(api, container);
      registerCatalogRoutes(api, container);
      registerMetadataRoutes(api, container);
      registerExplorerRoutes(api, container);
      registerDownloadRoutes(api, container);
      registerLibraryRoutes(api, container);
      registerPlaybackRoutes(api, container);
      registerSourceRoutes(api, container);
      api.setNotFoundHandler((request, reply) =>
        reply.code(404).send({
          error: 'NOT_FOUND',
          message: `Route inconnue : ${request.method} ${request.url}`,
        }),
      );
    },
    { prefix: '/api' },
  );

  await registerWebApp(app, container);
  return app;
}

/** Sert l'interface compilée (SPA) : fichiers statiques + repli sur index.html. */
async function registerWebApp(app: FastifyInstance, container: Container): Promise<void> {
  const root = container.config.webDistDir;
  if (!fs.existsSync(`${root}/index.html`)) {
    container.logger.warn(
      { root },
      'Interface web non compilée : lancez « npm run build » (ou utilisez « npm run dev » pour le développement).',
    );
    return;
  }
  await app.register(fastifyStatic, {
    root,
    wildcard: false,
    setHeaders: (response, filePath) => {
      response.header(
        'cache-control',
        filePath.includes(`${root}/assets/`) ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    },
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.method !== 'GET' || request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'Ressource introuvable.' });
    }
    return reply.header('cache-control', 'no-cache').sendFile('index.html');
  });
}
