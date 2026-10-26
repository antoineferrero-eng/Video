// Prototype de l'application de bureau Lumière (étape 1).
//
// Vérifie, sur la machine de l'utilisateur, le parcours qui servira à Lumière :
//   1. connexion à loadix dans une fenêtre (session gardée) ;
//   2. « Télécharger » : la fiche s'ouvre sur le lien choisi, l'utilisateur passe la
//      vérification Cloudflare, le lien 1fichier révélé est récupéré ;
//   3. lien direct demandé à l'API 1fichier premium, puis lecture de plages d'octets.
// Chaque essai produit un rapport (dossier « rapports » de l'application).
import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, app, clipboard, ipcMain, shell } from 'electron';
import { apiOrigin, loadConfig, saveConfig } from './config.mjs';
import {
  cancelReveal,
  checkAccount,
  listLinks,
  loadixSession,
  logout,
  openLogin,
  parseMediaId,
  revealInBrowser,
  revealLink,
  setupLoadixSession,
} from './loadix.mjs';
import { accountInfo, directLink, fileInfo, readRange } from './onefichier.mjs';

const MB = 1_048_576;
let control = null;

// Dossier propre au prototype (sans accent : %APPDATA%\Lumiere-prototype sous Windows), fixé
// avant tout accès au disque : la session loadix, les réglages et les rapports y sont gardés.
app.setPath('userData', path.join(app.getPath('appData'), 'Lumiere-prototype'));

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => control?.focus());
app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  setupLoadixSession(log);
  registerHandlers();
  control = new BrowserWindow({
    width: 1000,
    height: 900,
    title: 'Lumière — prototype de bureau',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
    },
  });
  control.webContents.on('will-navigate', (event) => event.preventDefault());
  control.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  control.loadFile(path.join(import.meta.dirname, 'ui', 'index.html'));
  log(`Electron ${process.versions.electron} (Chromium ${process.versions.chrome}).`);
  log(`Données du prototype : ${app.getPath('userData')}`);
});

function log(message) {
  const line = `[${new Date().toLocaleTimeString('fr-FR')}] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'journal.log'), line + '\n');
  } catch {
    // Journal sur disque facultatif.
  }
  if (control && !control.isDestroyed()) control.webContents.send('log', line);
}

function handle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    // Seule la fenêtre de contrôle (fichier local) parle au processus principal.
    if (!event.senderFrame?.url.startsWith('file:')) throw new Error('Origine refusée.');
    return handler(...args);
  });
}

function registerHandlers() {
  handle('config:get', () => publicConfig(loadConfig()));
  handle('config:save', (patch) => {
    const saved = saveConfig(patch);
    log('Réglages enregistrés.');
    return publicConfig(saved);
  });

  handle('loadix:login', async () => {
    log('Ouverture de la page de connexion loadix…');
    await openLogin(control, loadConfig(), log);
    return account();
  });
  handle('loadix:account', account);
  handle('loadix:logout', async () => {
    await logout(loadConfig());
    log('Session loadix effacée.');
    return account();
  });
  handle('loadix:links', async (mediaInput) => {
    const result = await listLinks(loadConfig(), mediaInput);
    log(`${result.title} : ${result.links.length} lien(s) affiché(s) sur ${result.total}.`);
    return result;
  });
  handle('loadix:reveal-test', revealAndTest);
  handle('loadix:reveal-cancel', () => cancelReveal());

  handle('onefichier:test', async () => {
    const info = await accountInfo(loadConfig().onefichierKey);
    log('Clé 1fichier acceptée.');
    // Les valeurs personnelles (adresse e-mail…) restent sur la machine : seuls les champs
    // utiles à l'abonnement sont affichés.
    return Object.fromEntries(
      Object.entries(info).filter(([key]) => !/mail|ip|name|phone|address/i.test(key)),
    );
  });

  handle('report:open-folder', () => shell.openPath(reportsDir()));
  handle('clipboard:write', (text) => clipboard.writeText(String(text)));
}

function publicConfig(config) {
  return {
    loadixUrl: config.loadixUrl,
    loadixApiUrl: config.loadixApiUrl,
    loadixApiEffective: apiOrigin(config),
    hasOnefichierKey: Boolean(config.onefichierKey),
  };
}

async function account() {
  const result = await checkAccount(loadConfig());
  if (result.connected) log(`Connecté à loadix en tant que ${result.username}.`);
  else if (result.connected === false) log(`Non connecté à loadix (${result.detail}).`);
  return result;
}

/**
 * Le parcours complet sur un lien : révélation, puis 1fichier. Produit toujours un rapport.
 * mode « fenetre » : fiche ouverte dans une fenêtre du prototype ; « navigateur » : dans le
 * navigateur habituel, lien repris dans le presse-papiers.
 */
async function revealAndTest(mediaInput, linkId, linkSummary, mode = 'fenetre') {
  const config = loadConfig();
  const mediaId = parseMediaId(mediaInput);
  const report = {
    date: new Date().toISOString(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    userAgent: loadixSession().getUserAgent(),
    mode,
    loadix: { site: config.loadixUrl, api: apiOrigin(config), mediaId, linkId, linkSummary },
    etapes: [],
  };
  const step = (name, data) => report.etapes.push({ etape: name, ...data });

  try {
    log('Ouverture du lien sur loadix…');
    const started = Date.now();
    const revealed =
      mode === 'navigateur'
        ? await revealInBrowser(config, mediaId, linkId, log)
        : await revealLink(control, config, mediaId, linkId, log);
    step('révélation', { dureeSecondes: Math.round((Date.now() - started) / 1000), ...revealed });
    log(`Lien révélé : ${mask(revealed.url)}${revealed.password ? ' (avec mot de passe)' : ''}.`);

    if (!config.onefichierKey) {
      step('1fichier', { ignore: 'aucune clé API enregistrée' });
      log('Pas de clé 1fichier : test arrêté au lien révélé.');
      return finishReport(report);
    }
    if (!/1fichier\.com/i.test(revealed.url)) {
      step('1fichier', { ignore: 'le lien révélé n’est pas un lien 1fichier' });
      return finishReport(report);
    }

    const info = await fileInfo(config.onefichierKey, revealed.url, revealed.password);
    step('1fichier : fichier', {
      filename: info.filename,
      size: info.size,
      type: info['content-type'],
    });
    log(`1fichier : ${info.filename} (${formatSize(info.size)}).`);

    const direct = await directLink(config.onefichierKey, revealed.url, revealed.password);
    step('1fichier : lien direct', { url: direct });
    log(`Lien direct obtenu (${new URL(direct).host}).`);

    log('Lecture des 8 premiers Mo…');
    const head = await readRange(direct, 0, 8 * MB);
    step('lecture : début du fichier', head);
    log(
      `Début du fichier : HTTP ${head.status}, ${formatSize(head.received)}, ${head.debitMoParSeconde} Mo/s.`,
    );

    const total = Number(info.size) || totalFromRange(head.contentRange);
    if (total > 16 * MB) {
      log('Lecture de deux morceaux en parallèle (milieu et trois quarts du fichier)…');
      const [middle, threeQuarters] = await Promise.all([
        readRange(direct, Math.floor(total / 2), 4 * MB),
        readRange(direct, Math.floor((total * 3) / 4), 4 * MB),
      ]);
      step('lecture : deux morceaux en parallèle', { middle, threeQuarters });
      log(`Morceaux en parallèle : HTTP ${middle.status} et ${threeQuarters.status}.`);
    }
    log('Parcours complet réussi.');
  } catch (error) {
    step('erreur', {
      message: error.message,
      captchaConfig: error.captchaConfig,
      diagnostics: error.diagnostics,
    });
    log(`Échec : ${error.message}`);
  }
  return finishReport(report);
}

function finishReport(report) {
  fs.mkdirSync(reportsDir(), { recursive: true });
  const file = path.join(reportsDir(), `rapport-${report.date.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  log(`Rapport enregistré : ${file}`);
  // Version à partager : liens et mots de passe masqués.
  return { file, shareable: JSON.stringify(maskDeep(report), null, 2) };
}

function reportsDir() {
  return path.join(app.getPath('userData'), 'rapports');
}

/** Garde l'hôte et le début d'un lien, masque le reste (identifiant de fichier, jeton). */
function mask(value) {
  return String(value).replace(/(https?:\/\/[^/\s]+\/)([^\s"]*)/g, (_all, origin, rest) => {
    const visible = rest.slice(0, 5);
    return `${origin}${visible}${rest.length > 5 ? '…(masqué)' : ''}`;
  });
}

function maskDeep(value) {
  if (typeof value === 'string') return mask(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        key === 'password' && inner ? '(masqué)' : maskDeep(inner),
      ]),
    );
  }
  return value;
}

function totalFromRange(contentRange) {
  const match = /\/(\d+)\s*$/.exec(contentRange ?? '');
  return match ? Number(match[1]) : 0;
}

function formatSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return 'taille inconnue';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} Go`;
  return `${(value / MB).toFixed(1)} Mo`;
}
