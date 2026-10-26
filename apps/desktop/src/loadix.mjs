// Accès à loadix depuis une session de navigateur dédiée (cookies gardés sur le disque).
//
// Les pages de loadix s'affichent dans de vraies fenêtres Chromium : c'est l'utilisateur qui
// s'y connecte et qui passe la vérification Cloudflare Turnstile. Aucun débogueur n'est
// attaché (c'est ce qui faisait boucler la vérification dans l'ancienne version) : Lumière
// observe seulement les codes de réponse des requêtes et lit la page une fois le lien affiché.
import { BrowserWindow, clipboard, session, shell } from 'electron';
import { apiOrigin } from './config.mjs';

const PARTITION = 'persist:loadix';
/** Monde isolé où l'on lit la page : les scripts du site n'y voient rien. */
const ISOLATED_WORLD = 1717;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const REVEAL_TIMEOUT_MS = 5 * 60_000;
/** Services de vérification anti-robot dont on note les échanges pour le diagnostic. */
const CAPTCHA_HOSTS = ['*://challenges.cloudflare.com/*', '*://*.hcaptcha.com/*'];
const CAPTCHA_MESSAGE = /turnstile|cloudflare|captcha|challenge/i;

/** Jeton d'accès obtenu au dernier contrôle de la connexion (gardé en mémoire seulement). */
let accessToken = null;
const requestObservers = new Set();
const openWindows = new Set();
/** Annule l'attente de révélation en cours (bouton « Annuler » de la fenêtre de contrôle). */
let cancelCurrent = null;

export function cancelReveal() {
  cancelCurrent?.();
}

export function loadixSession() {
  return session.fromPartition(PARTITION);
}

export function setupLoadixSession(log) {
  const ses = loadixSession();
  ses.setPermissionRequestHandler((contents, permission, callback) => {
    log(`Permission refusée à la page : ${permission}`);
    note(contents, `permission refusée : ${permission}`);
    callback(false);
  });
  ses.on('will-download', (event, item) => {
    event.preventDefault();
    log(`Téléchargement lancé par la page, bloqué : ${item.getURL()}`);
  });
  // Un seul observateur par session : il redistribue aux attentes en cours.
  ses.webRequest.onCompleted(
    { urls: ['*://*/api/links/*', '*://*/api/auth/*', '*://*/api/captcha/*', ...CAPTCHA_HOSTS] },
    (details) => {
      if (isCaptchaRequest(details.url) && details.statusCode >= 400) {
        note(details.webContents, `HTTP ${details.statusCode} ${shortUrl(details.url)}`);
      }
      for (const observer of requestObservers) observer(details);
    },
  );
  ses.webRequest.onErrorOccurred({ urls: CAPTCHA_HOSTS }, (details) => {
    note(details.webContents, `échec réseau ${details.error} ${shortUrl(details.url)}`);
  });
}

/**
 * Notes de diagnostic d'une fenêtre loadix : messages de la console liés à la vérification
 * (Turnstile y écrit son code d'erreur), refus de permission, échecs vers Cloudflare.
 */
const diagnostics = new WeakMap();

function note(contents, message) {
  const notes = contents && diagnostics.get(contents);
  if (!notes || notes.length >= 50) return;
  notes.push(`${new Date().toISOString().slice(11, 19)} ${message}`);
}

function isCaptchaRequest(url) {
  return /^https?:\/\/(challenges\.cloudflare\.com|[^/]*hcaptcha\.com)\//i.test(url);
}

function shortUrl(url) {
  const { host, pathname } = new URL(url);
  return `${host}${pathname.slice(0, 60)}`;
}

function observeRequests(observer) {
  requestObservers.add(observer);
  return () => requestObservers.delete(observer);
}

function loadixWindow(parent, url, title, log) {
  const site = new URL(url).hostname;
  const win = new BrowserWindow({
    parent,
    width: 1100,
    height: 820,
    title,
    autoHideMenuBar: true,
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true },
  });
  openWindows.add(win);
  win.on('closed', () => openWindows.delete(win));
  const notes = [];
  diagnostics.set(win.webContents, notes);
  win.diagnostics = notes;
  win.webContents.on('console-message', ({ message, level }) => {
    if (level === 'debug' || !CAPTCHA_MESSAGE.test(message)) return;
    note(win.webContents, `console (${level}) : ${message.slice(0, 300)}`);
    log(`Console de la page (${level}) : ${message.slice(0, 200)}`);
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    let host = '';
    try {
      host = new URL(target).hostname;
    } catch {
      // Adresse illisible : refusée ci-dessous.
    }
    if (host === site || host.endsWith(`.${site}`)) return { action: 'allow' };
    log(`Ouverture d’une nouvelle fenêtre bloquée : ${target}`);
    return { action: 'deny' };
  });
  win.loadURL(url);
  return win;
}

/** Identifiant loadix d'une fiche, depuis son adresse (…/media/<id>) ou l'identifiant seul. */
export function parseMediaId(input) {
  const match = String(input).match(UUID);
  if (!match) throw new Error('Aucun identifiant de fiche loadix trouvé (adresse …/media/<id>).');
  return match[0].toLowerCase();
}

/**
 * Ouvre la page de connexion. La fenêtre se ferme seule peu après une connexion réussie
 * (réponse 2xx de api/auth/login…) ; l'utilisateur peut aussi la fermer lui-même.
 */
export function openLogin(parent, config, log) {
  return new Promise((resolve) => {
    const win = loadixWindow(parent, `${config.loadixUrl}/auth/login`, 'loadix — connexion', log);
    const stop = observeRequests(({ url, method, statusCode }) => {
      const { pathname } = new URL(url);
      if (!pathname.startsWith('/api/auth/login') || method !== 'POST') return;
      if (statusCode >= 200 && statusCode < 300) {
        log('Connexion réussie sur loadix : fermeture de la fenêtre.');
        setTimeout(() => !win.isDestroyed() && win.close(), 1500);
      } else {
        log(`Connexion refusée par loadix (HTTP ${statusCode}).`);
      }
    });
    win.on('closed', () => {
      stop();
      resolve();
    });
  });
}

/**
 * Vérifie la connexion comme le fait le site au chargement : POST api/auth/refresh avec les
 * cookies de la session, qui renvoie l'utilisateur et un jeton d'accès. Fait seulement quand
 * aucune page loadix n'est ouverte, pour ne pas renouveler le jeton sous ses pieds.
 */
export async function checkAccount(config) {
  if (openWindows.size > 0) {
    return { connected: null, detail: 'Fermez la fenêtre loadix pour vérifier la connexion.' };
  }
  const response = await loadixSession().fetch(`${apiOrigin(config)}/api/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  const { json, text } = await readBody(response);
  if (response.ok && json?.accessToken) {
    accessToken = json.accessToken;
    const user = json.user ?? {};
    return {
      connected: true,
      username: user.username ?? user.displayName ?? user.name ?? '(pseudo inconnu)',
      // Pour le rapport : les champs disponibles, sans leurs valeurs.
      userFields: Object.keys(user),
    };
  }
  accessToken = null;
  return {
    connected: false,
    detail: `HTTP ${response.status} — ${json?.code ?? json?.message ?? text.slice(0, 160)}`,
  };
}

export async function logout(config) {
  try {
    await loadixSession().fetch(`${apiOrigin(config)}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: authHeaders(),
    });
  } catch {
    // Le site peut être injoignable : on efface la session de toute façon.
  }
  accessToken = null;
  await loadixSession().clearStorageData();
}

/** Fiche et liens d'un titre (API JSON de loadix, sans vérification). */
export async function listLinks(config, mediaInput) {
  const mediaId = parseMediaId(mediaInput);
  const api = apiOrigin(config);
  const media = await getJson(`${api}/api/media/${mediaId}`);
  const links = await getJson(`${api}/api/media/${mediaId}/links`);
  return {
    mediaId,
    title: media.media?.title ?? '(sans titre)',
    year: media.media?.year ?? null,
    type: media.media?.type ?? null,
    tmdbId: media.media?.tmdbId ?? null,
    total: links.total ?? links.items?.length ?? 0,
    links: (links.items ?? []).map((link) => ({
      id: link.id,
      provider: link.provider,
      linkType: link.linkType,
      quality: link.quality,
      language: link.language,
      sizeHuman: link.sizeHuman,
      sizeBytes: link.sizeBytes,
      releaseName: link.releaseName,
      scope: link.scope,
      seasonNumber: link.seasonNumber,
      episodeNumber: link.episodeNumber,
    })),
  };
}

/**
 * Ouvre la fiche sur le lien choisi (…/media/<id>?link=<lien>), clique « Révéler » si le bouton
 * est sans ambiguïté, laisse l'utilisateur passer la vérification, puis lit le lien affiché.
 */
export function revealLink(parent, config, mediaId, linkId, log) {
  return new Promise((resolve, reject) => {
    const url = `${config.loadixUrl}/media/${mediaId}?link=${encodeURIComponent(linkId)}`;
    const win = loadixWindow(parent, url, 'loadix — vérification', log);
    const revealResponses = [];
    // Adresses déjà visibles avant la révélation : le lien révélé est celui qui apparaît ensuite.
    const before = new Set();
    let clicked = false;
    let clickAttempts = 0;
    let settled = false;
    let timer = null;
    let timeout = null;
    let captchaConfig = null;
    captchaProvider(config).then((value) => (captchaConfig = value));

    const stop = observeRequests(({ url: requestUrl, method, statusCode }) => {
      const { pathname } = new URL(requestUrl);
      if (method !== 'POST') return;
      if (pathname !== `/api/links/${linkId}/reveal` && pathname !== '/api/links/reveal-bulk')
        return;
      revealResponses.push({ path: pathname, status: statusCode, at: new Date().toISOString() });
      log(
        statusCode < 400
          ? `Révélation acceptée par loadix (HTTP ${statusCode}).`
          : `Révélation refusée par loadix (HTTP ${statusCode}) : réessayez dans la fenêtre.`,
      );
    });
    const revealAccepted = () => revealResponses.some((response) => response.status < 400);

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearTimeout(timeout);
      stop();
      cancelCurrent = null;
      if (!win.isDestroyed()) win.close();
      const extra = { captchaConfig, diagnostics: [...win.diagnostics] };
      if (error) reject(Object.assign(error, extra));
      else resolve({ ...value, ...extra });
    };
    cancelCurrent = () => finish(new Error('Essai annulé.'));

    timeout = setTimeout(
      () => finish(new Error('Aucun lien révélé au bout de 5 minutes.')),
      REVEAL_TIMEOUT_MS,
    );
    win.on('closed', () => finish(new Error('Fenêtre fermée avant que le lien soit révélé.')));

    timer = setInterval(async () => {
      if (settled || win.isDestroyed() || win.webContents.isLoading()) return;
      let page;
      try {
        page = await win.webContents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [
          { code: READ_PAGE },
        ]);
      } catch {
        return; // Page en cours de navigation.
      }
      if (settled) return;

      if (!revealAccepted()) {
        for (const candidate of page.urls) before.add(candidate);
        if (!clicked && clickAttempts < 20) clickReveal(page);
        return;
      }

      const revealed = page.urls.filter((candidate) => !before.has(candidate));
      const onefichier = revealed.find((candidate) => ONEFICHIER.test(candidate));
      if (revealed.length === 0) return;
      finish(null, {
        url: onefichier ?? revealed[0],
        password: page.password,
        newLinks: revealed,
        revealResponses,
        labels: page.labels,
      });
    }, 1000);

    async function clickReveal(page) {
      clickAttempts += 1;
      if (page.revealButtons === 1) {
        clicked = true;
        await win.webContents
          .executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: CLICK_REVEAL }], true)
          .catch(() => {});
        log('Bouton « Révéler » cliqué : cochez la case Cloudflare si elle apparaît.');
      } else if (clickAttempts === 20) {
        clicked = true;
        log(
          page.revealButtons > 1
            ? `${page.revealButtons} boutons « Révéler » sur la page : cliquez vous-même sur celui du lien choisi.`
            : 'Bouton « Révéler » introuvable : cliquez vous-même pour révéler le lien.',
        );
      }
    }
  });
}

/**
 * Variante sans fenêtre Lumière : la fiche s'ouvre dans le navigateur habituel (Edge,
 * Chrome…), où l'utilisateur révèle le lien comme d'habitude puis clique « Copier » ; le
 * lien 1fichier est repris dans le presse-papiers dès qu'il y apparaît.
 */
export async function revealInBrowser(config, mediaId, linkId, log) {
  const url = `${config.loadixUrl}/media/${mediaId}?link=${encodeURIComponent(linkId)}`;
  // Le presse-papiers d'Electron est asynchrone : on ne reprend que ce qui est copié ensuite.
  const previous = (await clipboard.readText()).trim();
  return new Promise((resolve, reject) => {
    let settled = false;
    let reading = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearTimeout(timeout);
      cancelCurrent = null;
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setInterval(async () => {
      if (reading || settled) return;
      reading = true;
      try {
        const text = (await clipboard.readText()).trim();
        if (text === previous) return;
        const match = text.match(/https?:\/\/(?:[a-z0-9-]+\.)?1fichier\.com\/\S+/i);
        if (match) finish(null, { url: match[0], password: null, source: 'presse-papiers' });
      } catch {
        // Presse-papiers momentanément indisponible : nouvel essai au tour suivant.
      } finally {
        reading = false;
      }
    }, 500);
    const timeout = setTimeout(
      () => finish(new Error('Aucun lien 1fichier copié au bout de 5 minutes.')),
      REVEAL_TIMEOUT_MS,
    );
    cancelCurrent = () => finish(new Error('Essai annulé.'));
    shell.openExternal(url).then(
      () =>
        log(
          'Fiche ouverte dans votre navigateur : révélez le lien, puis cliquez « Copier » (ou copiez le lien 1fichier).',
        ),
      (error) => finish(new Error(`Navigateur impossible à ouvrir : ${error.message}`)),
    );
  });
}

/** Service de vérification choisi par loadix pour les révélations (Turnstile ou hCaptcha). */
async function captchaProvider(config) {
  try {
    const json = await getJson(`${apiOrigin(config)}/api/captcha/config`);
    return { provider: json.provider ?? '(non précisé)', champs: Object.keys(json) };
  } catch (error) {
    return { erreur: error.message };
  }
}

const ONEFICHIER = /^https?:\/\/(?:[a-z0-9-]+\.)?1fichier\.com\//i;

// Lecture de la page (monde isolé) : liens visibles, boutons « Révéler », mot de passe affiché.
// Le site affiche le résultat sous les libellés « Lien direct » et « Mot de passe ».
const READ_PAGE = `(() => {
  const urls = new Set();
  const add = (value) => {
    for (const match of String(value || '').matchAll(/https?:\\/\\/[^\\s"'<>]+/g)) urls.add(match[0]);
  };
  document.querySelectorAll('a[href]').forEach((a) => add(a.href));
  document.querySelectorAll('input, textarea').forEach((field) => add(field.value));
  document.querySelectorAll('code, pre, [data-url]').forEach((node) => add(node.textContent));
  const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(
    (b) => /^\\s*(révéler|reveal)\\b/i.test(b.textContent || '') && !b.disabled,
  );
  const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
  const inDialog = dialog ? buttons.filter((b) => dialog.contains(b)) : [];
  const valueNear = (label) => {
    const node = [...document.querySelectorAll('body *')].find(
      (el) => el.childElementCount === 0 && (el.textContent || '').trim() === label,
    );
    if (!node) return null;
    const box = node.parentElement;
    const field = box && box.querySelector('input, textarea, code');
    if (field) return (field.value ?? field.textContent ?? '').trim() || null;
    const text = (box ? box.textContent : '').replace(label, '').trim();
    return text || null;
  };
  return {
    urls: [...urls],
    revealButtons: inDialog.length === 1 ? 1 : buttons.length,
    password: valueNear('Mot de passe') ?? valueNear('Password'),
    labels: { lienDirect: valueNear('Lien direct') ?? valueNear('Direct link') },
  };
})()`;

const CLICK_REVEAL = `(() => {
  const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(
    (b) => /^\\s*(révéler|reveal)\\b/i.test(b.textContent || '') && !b.disabled,
  );
  const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
  const inDialog = dialog ? buttons.filter((b) => dialog.contains(b)) : [];
  const target = inDialog.length === 1 ? inDialog[0] : buttons.length === 1 ? buttons[0] : null;
  if (target) target.click();
  return Boolean(target);
})()`;

function authHeaders() {
  return {
    accept: 'application/json',
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
  };
}

async function getJson(url) {
  const response = await loadixSession().fetch(url, { headers: authHeaders() });
  const { json, text } = await readBody(response);
  if (!response.ok || !json) {
    throw new Error(
      `loadix : ${new URL(url).pathname} → HTTP ${response.status} ${json?.code ?? text.slice(0, 160)}`,
    );
  }
  return json;
}

async function readBody(response) {
  const text = await response.text();
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}
