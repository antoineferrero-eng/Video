// Client minimal de l'API officielle 1fichier (comptes premium) : https://1fichier.com/api.html
// Toutes les méthodes sont des POST JSON authentifiés par « Authorization: Bearer <clé> ».

const API = 'https://api.1fichier.com/v1/';
/** 1fichier limite le rythme des appels : on laisse au moins cet écart entre deux requêtes. */
const MIN_INTERVAL_MS = 2_000;

let lastCall = 0;

async function call(key, method, body = {}) {
  if (!key) throw new Error('Aucune clé API 1fichier enregistrée.');
  const wait = lastCall + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCall = Date.now();
  const response = await fetch(API + method, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `1fichier (${method}) : réponse illisible, HTTP ${response.status} — ${text.slice(0, 200)}`,
    );
  }
  if (!response.ok || json.status === 'KO') {
    throw new Error(`1fichier (${method}) : ${json.message ?? `HTTP ${response.status}`}`);
  }
  return json;
}

/** Informations du compte (sert à vérifier la clé et l'abonnement). */
export function accountInfo(key) {
  return call(key, 'user/info.cgi');
}

/** Nom, taille… d'un fichier 1fichier à partir de son lien. */
export function fileInfo(key, url, pass) {
  return call(key, 'file/info.cgi', pass ? { url, pass } : { url });
}

/** Lien de téléchargement direct (premium) pour un lien 1fichier. */
export async function directLink(key, url, pass) {
  const json = await call(key, 'download/get_token.cgi', pass ? { url, pass } : { url });
  if (!json.url) throw new Error('1fichier n’a pas renvoyé de lien direct.');
  return json.url;
}

/**
 * Lit une plage d'octets du lien direct pour vérifier ce dont le moteur de téléchargement
 * de Lumière a besoin : réponse 206, taille totale, accès au milieu du fichier, débit.
 */
export async function readRange(url, start, length) {
  const began = Date.now();
  const response = await fetch(url, {
    headers: { range: `bytes=${start}-${start + length - 1}` },
    signal: AbortSignal.timeout(60_000),
  });
  let received = 0;
  if (response.body) {
    // Un serveur qui ignore « Range » renverrait tout le fichier (200) : on s'arrête à la plage.
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received >= length) break;
    }
  }
  const seconds = Math.max((Date.now() - began) / 1000, 0.001);
  return {
    status: response.status,
    contentRange: response.headers.get('content-range'),
    acceptRanges: response.headers.get('accept-ranges'),
    contentType: response.headers.get('content-type'),
    disposition: response.headers.get('content-disposition'),
    received,
    debitMoParSeconde: Number((received / 1_048_576 / seconds).toFixed(2)),
  };
}
