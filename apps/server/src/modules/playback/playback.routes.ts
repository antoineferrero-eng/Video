import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Container } from '../../container';
import { MediaRefSchema } from '../shared-schemas';

const CodecList = z.array(z.string().max(20)).max(30);
const SessionParams = z.object({ id: z.uuid() });
const StreamId = z.string().regex(/^[\w-]{1,64}$/);

const TrackParams = SessionParams.extend({ trackId: z.string().max(40) });

export function registerPlaybackRoutes(
  server: FastifyInstance,
  { playback, subtitleSync }: Container,
): void {
  const app = server.withTypeProvider<ZodTypeProvider>();

  app.post(
    '/playback/sessions',
    {
      schema: {
        body: z.object({
          media: MediaRefSchema,
          capabilities: z.object({
            videoCodecs: CodecList,
            audioCodecs: CodecList,
            containers: CodecList,
          }),
          audioTrack: z.number().int().min(0).nullable().optional(),
          mode: z.enum(['auto', 'transcode']).optional(),
        }),
      },
    },
    async (request) => playback.createSession(request.body),
  );

  app.route({
    method: ['GET', 'HEAD'],
    url: '/playback/sessions/:id/stream',
    schema: {
      params: SessionParams,
      querystring: z.object({
        start: z.coerce.number().min(0).max(1e7).default(0),
        stream: StreamId.optional(),
      }),
    },
    handler: async (request, reply) =>
      playback.stream(request.params.id, request.query.start, request.query.stream, request, reply),
  });

  app.get(
    '/playback/sessions/:id/streams/:streamId/origin',
    { schema: { params: SessionParams.extend({ streamId: StreamId }) } },
    async (request) => ({
      start: await playback.streamOrigin(request.params.id, request.params.streamId),
    }),
  );

  app.get(
    '/playback/sessions/:id/subtitles/online',
    {
      schema: {
        params: SessionParams,
        querystring: z.object({ force: z.stringbool().optional() }),
      },
    },
    async (request) =>
      playback.searchOnlineSubtitles(request.params.id, request.query.force ?? false),
  );

  // Recalage d'une piste : réglage gardé, réglage manuel, recalage automatique.
  app.get(
    '/playback/sessions/:id/subtitles/:trackId/sync',
    { schema: { params: TrackParams } },
    (request) => subtitleSync.state(request.params.id, request.params.trackId),
  );

  app.put(
    '/playback/sessions/:id/subtitles/:trackId/sync',
    {
      schema: {
        params: TrackParams,
        body: z.object({
          offset: z.number().min(-36_000).max(36_000),
          rate: z.number().min(0.8).max(1.25),
        }),
      },
    },
    (request) => ({
      sync: subtitleSync.save(request.params.id, request.params.trackId, request.body),
    }),
  );

  app.delete(
    '/playback/sessions/:id/subtitles/:trackId/sync',
    { schema: { params: TrackParams } },
    async (request, reply) => {
      subtitleSync.reset(request.params.id, request.params.trackId);
      return reply.code(204).send();
    },
  );

  app.post(
    '/playback/sessions/:id/subtitles/:trackId/sync/auto',
    { schema: { params: TrackParams } },
    async (request) => subtitleSync.auto(request.params.id, request.params.trackId),
  );

  app.get(
    '/playback/sessions/:id/subtitles/:trackId',
    { schema: { params: TrackParams } },
    async (request, reply) => {
      const vtt = await playback.subtitles(request.params.id, request.params.trackId);
      return reply
        .header('content-type', 'text/vtt; charset=utf-8')
        .header('cache-control', 'no-cache')
        .send(vtt);
    },
  );

  app.post(
    '/playback/sessions/:id/progress',
    {
      schema: {
        params: SessionParams,
        body: z.object({ position: z.number().min(0), duration: z.number().positive().nullable() }),
      },
    },
    async (request, reply) => {
      playback.saveProgress(request.params.id, request.body);
      return reply.code(204).send();
    },
  );

  app.delete(
    '/playback/sessions/:id',
    { schema: { params: SessionParams } },
    async (request, reply) => {
      playback.stopSession(request.params.id);
      return reply.code(204).send();
    },
  );

  app.get('/playback/continue', async () => playback.continueWatching());

  app.delete(
    '/playback/progress',
    { schema: { querystring: z.object({ mediaKey: z.string().min(1).max(3000) }) } },
    async (request, reply) => {
      playback.removeProgress(request.query.mediaKey);
      return reply.code(204).send();
    },
  );

  app.put(
    '/playback/watched',
    { schema: { body: z.object({ media: MediaRefSchema, watched: z.boolean() }) } },
    async (request, reply) => {
      playback.setWatched(request.body.media, request.body.watched);
      return reply.code(204).send();
    },
  );
}
