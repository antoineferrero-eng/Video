import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Container } from '../../container';
import { IdParams, booleanQuery } from '../shared-schemas';

export function registerDownloadRoutes(server: FastifyInstance, { downloads }: Container): void {
  const app = server.withTypeProvider<ZodTypeProvider>();

  app.get('/downloads', async () => downloads.list());

  app.post(
    '/downloads',
    {
      schema: {
        body: z.object({
          files: z
            .array(
              z.object({
                path: z.string().min(1).max(2000),
                titleId: z.number().int().positive().nullable().optional(),
              }),
            )
            .min(1)
            .max(2000),
        }),
      },
    },
    async (request, reply) => reply.code(201).send(downloads.enqueueFiles(request.body.files)),
  );

  app.post(
    '/downloads/title',
    {
      schema: {
        body: z.object({
          titleId: z.number().int().positive(),
          season: z.number().int().min(0).nullable().optional(),
          episode: z.number().int().min(0).nullable().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { titleId, season, episode } = request.body;
      return reply.code(201).send(await downloads.enqueueTitle(titleId, season, episode));
    },
  );

  app.post(
    '/downloads/folder',
    { schema: { body: z.object({ path: z.string().min(1).max(2000) }) } },
    async (request, reply) =>
      reply.code(201).send(await downloads.enqueueFolder(request.body.path)),
  );

  app.post('/downloads/:id/pause', { schema: { params: IdParams } }, async (request) =>
    downloads.pause(request.params.id),
  );
  app.post('/downloads/:id/resume', { schema: { params: IdParams } }, async (request) =>
    downloads.resume(request.params.id),
  );
  app.post('/downloads/:id/cancel', { schema: { params: IdParams } }, async (request) =>
    downloads.cancel(request.params.id),
  );

  app.delete(
    '/downloads/:id',
    { schema: { params: IdParams, querystring: z.object({ deleteFile: booleanQuery }) } },
    async (request, reply) => {
      await downloads.remove(request.params.id, request.query.deleteFile);
      return reply.code(204).send();
    },
  );

  app.post('/downloads/pause-all', async () => {
    downloads.pauseAll();
    return downloads.stats();
  });
  app.post('/downloads/resume-all', async () => {
    downloads.resumeAll();
    return downloads.stats();
  });
  app.post('/downloads/clear', async () => ({ removed: downloads.clearFinished() }));
}
