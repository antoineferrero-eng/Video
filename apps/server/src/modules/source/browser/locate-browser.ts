import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface BrowserExecutable {
  /** Nom affiché (« Google Chrome », « Microsoft Edge »…). */
  name: string;
  path: string;
}

/** Navigateurs Chromium, par ordre de préférence (l'imitation réseau reproduit Chrome). */
const WINDOWS: Array<[string, string]> = [
  ['Google Chrome', 'Google/Chrome/Application/chrome.exe'],
  ['Microsoft Edge', 'Microsoft/Edge/Application/msedge.exe'],
  ['Brave', 'BraveSoftware/Brave-Browser/Application/brave.exe'],
  ['Chromium', 'Chromium/Application/chrome.exe'],
];

const MACOS: Array<[string, string]> = [
  ['Google Chrome', 'Google Chrome.app/Contents/MacOS/Google Chrome'],
  ['Microsoft Edge', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  ['Brave', 'Brave Browser.app/Contents/MacOS/Brave Browser'],
  ['Chromium', 'Chromium.app/Contents/MacOS/Chromium'],
];

const LINUX: Array<[string, string]> = [
  ['Google Chrome', 'google-chrome-stable'],
  ['Google Chrome', 'google-chrome'],
  ['Chromium', 'chromium'],
  ['Chromium', 'chromium-browser'],
  ['Microsoft Edge', 'microsoft-edge-stable'],
  ['Microsoft Edge', 'microsoft-edge'],
  ['Brave', 'brave-browser'],
];

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function nameFromPath(executable: string): string {
  const base = path.basename(executable).toLowerCase();
  if (base.includes('edge')) return 'Microsoft Edge';
  if (base.includes('brave')) return 'Brave';
  if (base.includes('chromium')) return 'Chromium';
  if (base.includes('chrome')) return 'Google Chrome';
  return path.basename(executable);
}

/**
 * Cherche un navigateur basé sur Chromium installé sur la machine (Chrome, Edge, Brave,
 * Chromium). `BROWSER_PATH` permet d'en imposer un.
 */
export function locateBrowser(
  override: string | null = null,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): BrowserExecutable | null {
  if (override) return isFile(override) ? { name: nameFromPath(override), path: override } : null;
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(
      (root): root is string => Boolean(root),
    );
    for (const [name, relative] of WINDOWS) {
      for (const root of roots) {
        const candidate = path.win32.join(root, relative);
        if (isFile(candidate)) return { name, path: candidate };
      }
    }
    return null;
  }
  if (platform === 'darwin') {
    for (const [name, relative] of MACOS) {
      for (const root of ['/Applications', path.join(os.homedir(), 'Applications')]) {
        const candidate = path.join(root, relative);
        if (isFile(candidate)) return { name, path: candidate };
      }
    }
    return null;
  }
  const directories = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const [name, command] of LINUX) {
    for (const directory of directories) {
      const candidate = path.join(directory, command);
      if (isFile(candidate)) return { name, path: candidate };
    }
  }
  return null;
}
