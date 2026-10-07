import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Container } from '../../container';
import { booleanQuery } from '../shared-schemas';

export function registerExplorerRoutes(server: FastifyInstance, { explorer }: Container): void {
  const app = server.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/explorer',
    {
      schema: {
        querystring: z.object({ path: z.string().max(2000).default('/'), refresh: booleanQuery }),
      },
    },
    async (request) => explorer.list(request.query.path, request.query.refresh),
  );
}
