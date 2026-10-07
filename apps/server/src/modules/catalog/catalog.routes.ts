import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Container } from '../../container';
import { NotFoundError } from '../../core/errors';
import { IdParams } from '../shared-schemas';
import { imageUrl } from './presenters';

const KindSchema = z.enum(['movie', 'series']);

export function registerCatalogRoutes(
  server: FastifyInstance,
  { catalog, metadata }: Container,
): void {
  const app = server.withTypeProvider<ZodTypeProvider>();

  app.get('/home', async () => catalog.home());

  app.get(
    '/titles',
    {
      schema: {
        querystring: z.object({
          kind: KindSchema.optional(),
          q: z.string().max(200).optional(),
          sort: z.enum(['recent', 'title', 'year', 'rating']).optional(),
          genre: z.string().max(100).optional(),
          page: z.coerce.number().int().min(1).optional(),
          pageSize: z.coerce.number().int().min(1).max(100).optional(),
        }),
      },
    },
    async (request) => catalog.search(request.query),
  );

  app.get('/titles/:id', { schema: { params: IdParams } }, async (request) =>
    catalog.details(request.params.id),
  );

  /** Illustration « paresseuse » : déclenche la recherche TMDB au premier affichage. */
  app.get(
    '/titles/:id/artwork/:type',
    { schema: { params: IdParams.extend({ type: z.enum(['poster', 'backdrop']) }) } },
    async (request, reply) => {
      const row = await metadata.ensureById(request.params.id);
      if (!row) throw new NotFoundError('Titre introuvable.');
      const url =
        request.params.type === 'poster'
          ? imageUrl(row.poster_path, 'w342')
          : imageUrl(row.backdrop_path, 'w1280');
      if (!url) {
        return reply.code(404).header('cache-control', 'public, max-age=3600').send({
          error: 'NOT_FOUND',
          message: 'Aucune illustration.',
        });
      }
      return reply.header('cache-control', 'public, max-age=86400').redirect(url, 302);
    },
  );

  app.get(
    '/genres',
    { schema: { querystring: z.object({ kind: KindSchema.optional() }) } },
    async (request) => catalog.genres(request.query.kind),
  );

  app.get('/catalog/status', async () => catalog.statuses());

  app.post(
    '/catalog/refresh',
    { schema: { body: z.object({ kind: KindSchema.optional() }).optional() } },
    async (request, reply) => {
      const kinds = request.body?.kind ? [request.body.kind] : (['movie', 'series'] as const);
      for (const kind of kinds) catalog.refreshInBackground(kind);
      return reply.code(202).send(catalog.statuses());
    },
  );
}
