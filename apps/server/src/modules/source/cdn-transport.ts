import type { SourceRequest, SourceResponse, Transport } from './transport';

/**
 * Point d'accès de lecture de 111477 (`p.111477.xyz/bulk?u=<adresse du fichier>`), celui
 * qu'utilisent ses propres extensions (Stremio…) : il sert les fichiers aux connexions
 * résidentielles, dans la limite d'un réservoir de jetons par adresse IP. Lumière ne s'en
 * sert qu'en secours, pour les fichiers de 111477 dont le téléchargement direct est refusé.
 */
export interface CdnOptions {
  /** Adresse du point d'accès (le fichier est passé dans le paramètre `u`). */
  baseUrl: string;
  /** Hôtes de la source concernés. */
  hosts: RegExp;
}

export const DEFAULT_CDN: CdnOptions = {
  baseUrl: 'https://p.111477.xyz/bulk',
  hosts: /(^|\.)111477\.xyz$/i,
};

export class CdnTransport implements Transport {
  readonly name = 'cdn' as const;

  constructor(
    private readonly options: CdnOptions,
    /** Transport qui fait la requête (imitation de Chrome de préférence). */
    private readonly via: () => Promise<Transport>,
  ) {}

  appliesTo(url: string): boolean {
    return this.options.hosts.test(new URL(url).hostname);
  }

  /** Adresse du fichier via le point d'accès. */
  urlFor(url: string): string {
    const target = new URL(this.options.baseUrl);
    target.searchParams.set('u', url);
    return target.toString();
  }

  async fetch(url: string, request: SourceRequest): Promise<SourceResponse> {
    const transport = await this.via();
    const response = await transport.fetch(this.urlFor(url), { ...request, kind: 'file' });
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || !/text\/html|json/i.test(type)) return response;
    // Une page (erreur, limite atteinte…) au lieu du fichier : ce n'est pas un succès.
    const text = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim();
    return {
      status: 502,
      statusText: `p.111477.xyz n’a pas servi le fichier${text ? ` : ${text.slice(0, 200)}` : ''}`,
      ok: false,
      url: response.url,
      headers: response.headers,
      body: null,
      text: async () => text,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  }
}
