// Réglages du prototype, gardés dans le dossier de l'application (userData/reglages.json).
// La clé 1fichier est chiffrée par le système (DPAPI sous Windows) quand c'est possible.
import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';

const DEFAULTS = { loadixUrl: 'https://loadix.fun', loadixApiUrl: '', onefichierKey: '' };

function file() {
  return path.join(app.getPath('userData'), 'reglages.json');
}

export function loadConfig() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    // Premier lancement ou fichier illisible : valeurs par défaut.
  }
  return {
    loadixUrl: stored.loadixUrl || DEFAULTS.loadixUrl,
    loadixApiUrl: stored.loadixApiUrl || DEFAULTS.loadixApiUrl,
    onefichierKey: decryptKey(stored.onefichierKey),
  };
}

export function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  next.loadixUrl = normalizeOrigin(next.loadixUrl, 'adresse de loadix');
  next.loadixApiUrl = next.loadixApiUrl
    ? normalizeOrigin(next.loadixApiUrl, 'adresse de l’API loadix')
    : '';
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(
    file(),
    JSON.stringify({ ...next, onefichierKey: encryptKey(next.onefichierKey) }, null, 2),
  );
  return next;
}

/** Adresse de l'API : réglée à la main, sinon « api. » devant le domaine du site (api.loadix.fun). */
export function apiOrigin(config) {
  if (config.loadixApiUrl) return config.loadixApiUrl;
  const site = new URL(config.loadixUrl);
  return `${site.protocol}//api.${site.hostname}`;
}

function normalizeOrigin(value, label) {
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
  } catch {
    throw new Error(`L’${label} n’est pas une adresse valide : ${value}`);
  }
  return url.origin;
}

function encryptKey(key) {
  if (!key) return '';
  if (!safeStorage.isEncryptionAvailable()) return { clair: key };
  return { chiffre: safeStorage.encryptString(key).toString('base64') };
}

function decryptKey(stored) {
  if (!stored) return '';
  try {
    if (stored.chiffre) return safeStorage.decryptString(Buffer.from(stored.chiffre, 'base64'));
    return stored.clair ?? '';
  } catch {
    return '';
  }
}
