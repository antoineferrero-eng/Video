import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Container } from '../../container';
import { contentTypeForImage } from './image-cache';

export function registerMetadataRoutes(server: FastifyInstance, { images }: Container): void {
  const app = server.withTypeProvider<ZodTypeProvider>();

  /** Images TMDB servies depuis le cache disque local. */
  app.get(
    '/images/:size/:file',
    { schema: { params: z.object({ size: z.string().max(10), file: z.string().max(100) }) } },
    async (request, reply) => {
      const local = await images.get(request.params.size, request.params.file);
      return reply
        .header('content-type', contentTypeForImage(local))
        .header('cache-control', 'public, max-age=2592000, immutable')
        .send(fs.createReadStream(local));
    },
  );
}
