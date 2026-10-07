import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Container } from '../../container';
import { videoMimeType } from '../../domain/media-files';
import { sendLocalFile } from '../playback/streaming';
import { IdParams, booleanQuery } from '../shared-schemas';

export function registerLibraryRoutes(server: FastifyInstance, { library }: Container): void {
  const app = server.withTypeProvider<ZodTypeProvider>();

  app.get('/library', async () => library.list());

  app.get('/library/:id', { schema: { params: IdParams } }, async (request) =>
    library.get(request.params.id),
  );

  app.delete(
    '/library/:id',
    { schema: { params: IdParams, querystring: z.object({ deleteFile: booleanQuery }) } },
    async (request, reply) => {
      await library.remove(request.params.id, request.query.deleteFile);
      return reply.code(204).send();
    },
  );

  app.post('/library/scan', async () => library.scan());

  /** Téléchargement du fichier vers l'appareil qui consulte l'interface (téléphone, autre PC…). */
  app.get('/library/:id/file', { schema: { params: IdParams } }, async (request, reply) => {
    const row = library.getRow(request.params.id);
    return sendLocalFile(request, reply, row.file_path, {
      contentType: videoMimeType(row.file_name),
      downloadName: row.file_name,
    });
  });
}
