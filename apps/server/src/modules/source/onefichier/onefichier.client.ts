import { sleep } from '../../../core/async';
import {
  NotFoundError,
  ServiceUnavailableError,
  UpstreamError,
  errorMessage,
} from '../../../core/errors';

/**
 * Client de l'API officielle de 1fichier (https://1fichier.com/api.html). Toutes les
 * méthodes sont des POST JSON authentifiés par « Authorization: Bearer <clé> » ; le lien
 * direct d'un fichier est réservé aux comptes premium.
 *
 *   POST user/info.cgi                      compte (offre, fin d'abonnement)
 *   POST file/info.cgi { url, pass }        nom, taille d'un fichier
 *   POST download/get_token.cgi { url, pass }  lien direct, valable 5 minutes
 */

/** L'API accepte au plus 3 requêtes par seconde. */
const MIN_INTERVAL_MS = 400;
const TIMEOUT_MS = 20_000;

/** Offres de l'API (champ `offer` du compte). */
const OFFERS: Record<number, string> = {
  1: 'Premium',
  2: 'Access',
  3: 'Premium GOLD',
  4: 'Premium Light 500 Go',
  5: 'Premium Light 1000 Go',
};

export interface OneFichierAccount {
  email: string | null;
  /** Offre payante (null : compte gratuit, sans lien direct). */
  offer: string | null;
  subscriptionEnd: string | null;
  /** Champ `offer` tel que renvoyé par l'API (diagnostic d'une offre non reconnue). */
  rawOffer: unknown;
}

/**
 * Compte d'après `user/info.cgi`. L'offre peut arriver en nombre ou en texte ; un abonnement
 * dont la fin est à venir compte aussi comme offre payante.
 */
export function parseAccount(json: Record<string, unknown>, now = Date.now()): OneFichierAccount {
  const code = Number(json.offer);
  const subscriptionEnd =
    typeof json.subscription_end === 'string' && json.subscription_end
      ? json.subscription_end
      : null;
  // « AAAA-MM-JJ HH:MM:SS » (heure de Paris, à quelques heures près : sans importance ici).
  const until = subscriptionEnd ? Date.parse(subscriptionEnd.replace(' ', 'T')) : Number.NaN;
  let offer = Number.isInteger(code) && code > 0 ? (OFFERS[code] ?? `offre n° ${code}`) : null;
  if (!offer && until > now) offer = 'abonnement';
  return {
    email: typeof json.email === 'string' ? json.email : null,
    offer,
    subscriptionEnd,
    rawOffer: json.offer,
  };
}

export interface OneFichierFileDetails {
  fileName: string | null;
  size: number | null;
  checksum: string | null;
}

export interface OneFichierClientOptions {
  baseUrl: string;
  apiKey: () => string | null;
}

interface ApiResponse {
  status?: string;
  message?: string;
  [key: string]: unknown;
}

export class OneFichierClient {
  private lastCall = 0;
  private turn: Promise<void> = Promise.resolve();

  constructor(private readonly options: OneFichierClientOptions) {}

  get configured(): boolean {
    return this.options.apiKey() !== null;
  }

  async account(apiKey?: string): Promise<OneFichierAccount> {
    return parseAccount(await this.call('user/info.cgi', {}, apiKey));
  }

  async fileInfo(url: string, password: string | null): Promise<OneFichierFileDetails> {
    const json = await this.call('file/info.cgi', withPassword({ url }, password));
    return {
      fileName: typeof json.filename === 'string' && json.filename ? json.filename : null,
      size: typeof json.size === 'number' ? json.size : Number(json.size) || null,
      checksum: typeof json.checksum === 'string' && json.checksum ? json.checksum : null,
    };
  }

  /** Lien de téléchargement direct (compte premium), valable 5 minutes. */
  async downloadUrl(url: string, password: string | null): Promise<string> {
    const json = await this.call('download/get_token.cgi', withPassword({ url }, password));
    if (typeof json.url !== 'string' || !json.url) {
      throw new UpstreamError('1fichier n’a pas renvoyé de lien direct.');
    }
    return json.url;
  }

  private async call(
    method: string,
    body: Record<string, unknown>,
    apiKey = this.options.apiKey(),
  ): Promise<ApiResponse> {
    if (!apiKey) {
      throw new ServiceUnavailableError(
        'ONEFICHIER_NOT_CONFIGURED',
        'Ajoutez la clé d’API de votre compte 1fichier premium dans Paramètres → Sources.',
      );
    }
    await this.waitTurn();
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}/${method}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new UpstreamError(`API 1fichier injoignable : ${errorMessage(error)}`);
    }
    const text = await response.text();
    let json: ApiResponse | null = null;
    try {
      json = JSON.parse(text) as ApiResponse;
    } catch {
      // Réponse illisible : signalée ci-dessous.
    }
    if (response.ok && json && json.status !== 'KO') return json;
    const detail = json?.message ?? (text.slice(0, 160) || `HTTP ${response.status}`);
    if (response.status === 401) {
      throw new UpstreamError(`1fichier refuse la clé d’API : ${detail}`, 401);
    }
    if (response.status === 404) {
      throw new NotFoundError(`1fichier : fichier introuvable ou protégé (${detail}).`);
    }
    throw new UpstreamError(`1fichier : ${detail}`, response.status);
  }

  /** Appels l'un après l'autre, espacés pour respecter la limite de l'API. */
  private waitTurn(): Promise<void> {
    const next = this.turn.then(async () => {
      const wait = this.lastCall + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastCall = Date.now();
    });
    this.turn = next.catch(() => undefined);
    return next;
  }
}

function withPassword(
  body: Record<string, unknown>,
  password: string | null,
): Record<string, unknown> {
  return password ? { ...body, pass: password } : body;
}
