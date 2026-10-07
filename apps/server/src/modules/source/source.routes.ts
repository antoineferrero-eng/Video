import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Container } from '../../container';
import { AppError } from '../../core/errors';
import { proxyRemoteFile } from '../playback/streaming';
import { normalizeRemotePath } from './remote-path';

/** Relais interne réservé à ffmpeg/ffprobe (voir SourceRelay). */
export function registerSourceRoutes(server: FastifyInstance, container: Container): void {
  const { relay, source } = container;
  const app = server.withTypeProvider<ZodTypeProvider>();

  app.route({
    method: ['GET', 'HEAD'],
    url: '/internal/source',
    schema: {
      querystring: z.object({
        path: z.string().min(1).max(4000),
        token: z.string().max(200),
      }),
    },
    handler: async (request, reply) => {
      if (!relay.isValidToken(request.query.token)) {
        throw new AppError(403, 'FORBIDDEN', 'Accès réservé au serveur.');
      }
      const remotePath = normalizeRemotePath(request.query.path);
      return proxyRemoteFile(request, reply, source, remotePath, 'application/octet-stream');
    },
  });
}
