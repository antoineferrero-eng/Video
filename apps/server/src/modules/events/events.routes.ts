import type { FastifyInstance } from 'fastify';
import type { ServerEvent } from '@lumiere/shared';
import type { Container } from '../../container';

/** Flux Server-Sent Events : progression des téléchargements, catalogue, bibliothèque. */
export function registerEventRoutes(server: FastifyInstance, { events }: Container): void {
  server.get('/events', (request, reply) => {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.write('retry: 3000\n\n');

    const send = (event: ServerEvent) => {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = events.subscribe(send);
    const heartbeat = setInterval(() => response.write(': ping\n\n'), 25_000);

    response.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    request.log.debug('Client SSE connecté');
  });
}
