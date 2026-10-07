import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { NotFoundError, UpstreamError } from '../../core/errors';
import { parseRangeHeader } from '../../core/http-range';
import type { SourceClient } from '../source/source-client';

export function contentDisposition(
  fileName: string,
  type: 'attachment' | 'inline' = 'attachment',
): string {
  const fallback = fileName
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** Sert un fichier local en respectant les requêtes `Range` (seek natif du lecteur). */
export async function sendLocalFile(
  request: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
  options: { contentType: string; downloadName?: string },
): Promise<FastifyReply> {
  const stats = await fsp.stat(filePath).catch(() => null);
  if (!stats?.isFile()) throw new NotFoundError('Fichier introuvable sur le disque.');
  const size = stats.size;
  reply
    .header('accept-ranges', 'bytes')
    .header('content-type', options.contentType)
    .header('last-modified', stats.mtime.toUTCString())
    .header('cache-control', 'no-cache');
  if (options.downloadName)
    reply.header('content-disposition', contentDisposition(options.downloadName));

  const range = parseRangeHeader(request.headers.range, size);
  if (range === 'unsatisfiable') {
    return reply.code(416).header('content-range', `bytes */${size}`).send();
  }
  if (range) {
    reply
      .code(206)
      .header('content-range', `bytes ${range.start}-${range.end}/${size}`)
      .header('content-length', range.end - range.start + 1);
    if (request.method === 'HEAD') return reply.send();
    return reply.send(fs.createReadStream(filePath, { start: range.start, end: range.end }));
  }
  reply.header('content-length', size);
  if (request.method === 'HEAD') return reply.send();
  return reply.send(fs.createReadStream(filePath));
}

const FORWARDED_HEADERS = [
  'content-length',
  'content-range',
  'accept-ranges',
  'last-modified',
  'etag',
];

/**
 * Relaie un fichier de la source vers le navigateur (requêtes `Range` transmises),
 * ce qui permet de lire sans télécharger et sans souci de CORS.
 */
export async function proxyRemoteFile(
  request: FastifyRequest,
  reply: FastifyReply,
  source: SourceClient,
  remotePath: string,
  contentType: string,
): Promise<FastifyReply> {
  const controller = new AbortController();
  reply.raw.on('close', () => controller.abort());
  const upstream = await source.openFile(remotePath, {
    range: request.headers.range,
    signal: controller.signal,
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
  });
  if (upstream.status === 416) {
    await upstream.body?.cancel().catch(() => undefined);
    return reply
      .code(416)
      .header('content-range', upstream.headers.get('content-range') ?? '')
      .send();
  }
  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => undefined);
    if (upstream.status === 404) throw new NotFoundError('Fichier introuvable sur la source.');
    throw new UpstreamError(`La source a répondu ${upstream.status}.`, upstream.status);
  }
  reply.code(upstream.status);
  for (const header of FORWARDED_HEADERS) {
    const value = upstream.headers.get(header);
    if (value) reply.header(header, value);
  }
  if (!upstream.headers.get('accept-ranges')) reply.header('accept-ranges', 'bytes');
  reply.header('content-type', contentType).header('cache-control', 'no-cache');
  if (request.method === 'HEAD' || !upstream.body) return reply.send();
  return reply.send(Readable.fromWeb(upstream.body as unknown as NodeReadableStream<Uint8Array>));
}
