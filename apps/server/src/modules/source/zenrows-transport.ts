import { ConcurrencyLimiter, sleep } from '../../core/async';
import { UpstreamError } from '../../core/errors';
import type { Logger } from '../../core/logger';
import type { SourceRequest, SourceResponse, Transport } from './transport';

/**
 * Pages de listing obtenues par ZenRows, un service en ligne (payant, au crédit) qui passe
 * les vérifications anti-robot (Cloudflare…) avec de vrais navigateurs et des adresses IP
 * résidentielles. Seules les pages passent par ZenRows : les fichiers, volumineux, sont
 * téléchargés directement.
 */

interface Strategy {
  label: string;
  params: Record<string, string>;
}

/** Configurations essayées, de la moins chère à la plus robuste (seul un succès est facturé). */
export const ZENROWS_STRATEGIES: Strategy[] = [
  // ZenRows choisit lui-même la configuration la moins chère qui fonctionne.
  { label: 'mode automatique', params: { mode: 'auto' } },
  {
    label: 'rendu JavaScript + proxys résidentiels',
    params: { js_render: 'true', premium_proxy: 'true', wait: '3000' },
  },
];

/** Erreurs ZenRows qu'une autre configuration ne résoudra pas. */
const FATAL = /^(AUTH|REQS001)/;

const MESSAGES: Record<string, string> = {
  AUTH001: 'clé API ZenRows manquante',
  AUTH002: 'clé API ZenRows invalide (vérifiez-la dans Paramètres → Source)',
  AUTH004: 'crédits ZenRows épuisés (rechargez votre compte ZenRows)',
  REQS001: 'ZenRows refuse les requêtes vers ce site',
  REQS002: 'le site a renvoyé une erreur que ZenRows ne peut pas contourner',
};

interface ZenRowsError {
  code: string;
  title: string | null;
  detail: string | null;
}

function parseError(body: string): ZenRowsError | null {
  try {
    const data = JSON.parse(body) as { code?: unknown; title?: unknown; detail?: unknown };
    if (typeof data.code !== 'string' || !/^[A-Z]{3,4}\d{3,4}$/.test(data.code)) return null;
    return {
      code: data.code,
      title: typeof data.title === 'string' ? data.title : null,
      detail: typeof data.detail === 'string' ? data.detail : null,
    };
  } catch {
    return null;
  }
}

export function describeZenRowsError(error: ZenRowsError): string {
  const known = MESSAGES[error.code];
  const text = known ?? error.title ?? error.detail ?? 'erreur inconnue';
  return `ZenRows : ${text} (${error.code})`;
}

/** Page encore bloquée par la vérification Cloudflare malgré ZenRows. */
function stillChallenged(body: string): boolean {
  return /<title>\s*just a moment|_cf_chl_opt|cf-challenge-running|challenge-platform\/h\/[bg]\/orchestrate/i.test(
    body.slice(0, 20_000),
  );
}

export interface ZenRowsUsage {
  pages: number;
  credits: number;
}

export interface ZenRowsAttempt {
  strategy: string;
  status: number;
  credits: number | null;
  error: string | null;
  ms: number;
}

export class ZenRowsTransport implements Transport {
  readonly name = 'zenrows' as const;
  /** Index de la configuration qui a réussi la dernière fois (pour ne pas repayer d'échecs). */
  private preferred = 0;
  private readonly limiter = new ConcurrencyLimiter(2);
  private readonly totals: ZenRowsUsage = { pages: 0, credits: 0 };
  /** Détail du dernier appel (diagnostic). */
  lastAttempts: ZenRowsAttempt[] = [];

  constructor(
    private readonly apiKey: () => string | null,
    private readonly apiUrl: string,
    private readonly logger: Logger,
  ) {}

  get configured(): boolean {
    return this.apiKey() !== null;
  }

  usage(): ZenRowsUsage {
    return { ...this.totals };
  }

  reset(): void {
    this.preferred = 0;
  }

  async fetch(url: string, request: SourceRequest): Promise<SourceResponse> {
    if (request.kind !== 'document') {
      throw new UpstreamError('ZenRows ne sert qu’aux pages de listing, pas aux fichiers.');
    }
    const key = this.apiKey();
    if (!key) {
      throw new UpstreamError(
        'Mode ZenRows choisi, mais aucune clé API ZenRows n’est configurée (Paramètres → Source).',
      );
    }
    this.lastAttempts = [];
    let last: SourceResponse | null = null;
    for (let index = this.preferred; index < ZENROWS_STRATEGIES.length; index += 1) {
      const strategy = ZENROWS_STRATEGIES[index] as Strategy;
      const result = await this.limiter.run(() => this.call(url, key, strategy, request.signal));
      if (result.kind === 'page') {
        this.preferred = index;
        return result.response;
      }
      if (result.kind === 'fatal') throw new UpstreamError(result.message);
      last = result.response;
    }
    // Aucune configuration n'a suffi : on repartira de la moins chère la prochaine fois.
    this.preferred = 0;
    if (last) return last;
    const reasons = this.lastAttempts.map((attempt) => `${attempt.strategy} : ${attempt.error}`);
    throw new UpstreamError(`ZenRows n’a pas pu obtenir la page (${reasons.join(' ; ')}).`);
  }

  private async call(
    target: string,
    key: string,
    strategy: Strategy,
    signal: AbortSignal | undefined,
  ): Promise<
    | { kind: 'page'; response: SourceResponse }
    | { kind: 'retry'; response: SourceResponse | null }
    | { kind: 'fatal'; message: string }
  > {
    const endpoint = new URL(this.apiUrl);
    endpoint.searchParams.set('apikey', key);
    endpoint.searchParams.set('url', target);
    endpoint.searchParams.set('original_status', 'true');
    for (const [name, value] of Object.entries(strategy.params))
      endpoint.searchParams.set(name, value);

    const started = Date.now();
    let response = await fetch(endpoint, { signal });
    if (response.status === 429) {
      // Trop de requêtes simultanées pour l'offre : une seconde chance après une pause.
      await response.body?.cancel();
      await sleep(2_000, signal);
      response = await fetch(endpoint, { signal });
    }
    const body = await response.text();
    const credits = Number(
      response.headers.get('x-request-credits') ?? response.headers.get('x-request-cost') ?? NaN,
    );
    const attempt: ZenRowsAttempt = {
      strategy: strategy.label,
      status: response.status,
      credits: Number.isFinite(credits) ? credits : null,
      error: null,
      ms: Date.now() - started,
    };
    this.lastAttempts.push(attempt);

    const headers = new Headers({
      'content-type': response.headers.get('content-type') ?? 'text/html; charset=utf-8',
    });
    const finalUrl = response.headers.get('zr-final-url') ?? target;
    const page = pageResponse(response.status, response.statusText, finalUrl, headers, body);
    // Dossier absent : réponse définitive, inutile de payer une configuration plus robuste.
    if (response.status === 404) return { kind: 'page', response: page };

    const zenError = parseError(body);
    if (zenError) {
      attempt.error = describeZenRowsError(zenError);
      this.logger.warn(
        { code: zenError.code, strategy: strategy.label, status: response.status },
        'Erreur ZenRows',
      );
      if (FATAL.test(zenError.code)) return { kind: 'fatal', message: attempt.error };
      return { kind: 'retry', response: null };
    }

    if (response.ok && !stillChallenged(body)) {
      this.totals.pages += 1;
      if (attempt.credits !== null) this.totals.credits += attempt.credits;
      this.logger.info(
        { url: target, strategy: strategy.label, credits: attempt.credits, ms: attempt.ms },
        'Page obtenue via ZenRows',
      );
      return { kind: 'page', response: page };
    }
    attempt.error = response.ok
      ? 'page de vérification Cloudflare renvoyée'
      : `statut ${response.status}`;
    return { kind: 'retry', response: page };
  }
}

function pageResponse(
  status: number,
  statusText: string,
  url: string,
  headers: Headers,
  body: string,
): SourceResponse {
  const response = new Response(body, { status, statusText, headers });
  return {
    status,
    statusText,
    ok: response.ok,
    url,
    headers: response.headers,
    get body() {
      return response.body;
    },
    text: () => response.text(),
    arrayBuffer: () => response.arrayBuffer(),
  };
}
