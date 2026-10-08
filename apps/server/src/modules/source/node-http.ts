import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { SourceResponse } from './transport';

/**
 * Requête HTTP(S) bas niveau qui envoie exactement les en-têtes fournis (`fetch` en ajoute
 * et en réécrit), avec des connexions réutilisées : un lecteur vidéo enchaîne les plages.
 */
const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 16 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 16 }),
};

const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface NodeRequestInit {
  method?: 'GET' | 'HEAD';
  headers: Record<string, string>;
  signal?: AbortSignal;
}

class NodeResponse implements SourceResponse {
  readonly ok: boolean;
  private webStream: ReadableStream<Uint8Array> | null = null;

  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly url: string,
    readonly headers: Headers,
    private readonly stream: Readable | null,
  ) {
    this.ok = status >= 200 && status < 300;
  }

  /** Comme `Response.body` : toujours le même flux, créé à la première lecture. */
  get body(): ReadableStream<Uint8Array> | null {
    if (!this.stream) return null;
    this.webStream ??= Readable.toWeb(this.stream) as unknown as ReadableStream<Uint8Array>;
    return this.webStream;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const body = this.body;
    if (!body) return new ArrayBuffer(0);
    const chunks: Buffer[] = [];
    for await (const chunk of Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>))
      chunks.push(Buffer.from(chunk as Uint8Array));
    const buffer = Buffer.concat(chunks);
    return buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(await this.arrayBuffer());
  }
}

function toHeaders(raw: string[]): Headers {
  const headers = new Headers();
  for (let index = 0; index + 1 < raw.length; index += 2) {
    try {
      headers.append(raw[index] as string, raw[index + 1] as string);
    } catch {
      // En-tête invalide ignoré.
    }
  }
  return headers;
}

function once(url: URL, init: NodeRequestInit): Promise<http.IncomingMessage> {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      agent: agents[url.protocol as 'http:' | 'https:'],
      signal: init.signal,
    });
    request.on('response', resolve);
    request.on('error', reject);
    request.end();
  });
}

export async function nodeRequest(target: string, init: NodeRequestInit): Promise<SourceResponse> {
  let url = new URL(target);
  for (let redirects = 0; ; redirects += 1) {
    const response = await once(url, init);
    const location = response.headers.location;
    if (REDIRECTS.has(response.statusCode ?? 0) && location && redirects < MAX_REDIRECTS) {
      response.resume();
      url = new URL(location, url);
      continue;
    }
    const headers = toHeaders(response.rawHeaders);
    let stream: Readable | null = response;
    if ((init.method ?? 'GET') === 'HEAD') {
      response.resume();
      stream = null;
    }
    return new NodeResponse(
      response.statusCode ?? 0,
      response.statusMessage ?? '',
      url.toString(),
      headers,
      stream,
    );
  }
}
