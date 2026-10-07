import { useSyncExternalStore } from 'react';

/**
 * Préférences d'apparence du verre, propres à chaque appareil (stockage local), combinées
 * aux réglages d'accessibilité du système (transparence, contraste, mouvements réduits).
 * L'état effectif est reflété par des attributs sur <html> que lisent les feuilles de style :
 *   data-glass="clear|tinted|solid", data-refraction="on|off", data-light="on|off".
 */
export type GlassMaterial = 'clear' | 'tinted' | 'solid';

export interface AppearancePreferences {
  /** Transparent (Liquid Glass), Teinté (plus opaque, iOS 26.1) ou Opaque. */
  material: GlassMaterial;
  /** Réfraction des bords (effet lentille), si le navigateur sait l'afficher. */
  refraction: boolean;
  /** Reflets qui suivent le pointeur ou l'inclinaison de l'appareil. */
  dynamicLight: boolean;
}

export interface SystemPreferences {
  reducedTransparency: boolean;
  moreContrast: boolean;
  reducedMotion: boolean;
}

export interface AppearanceState {
  preferences: AppearancePreferences;
  system: SystemPreferences;
  refractionSupported: boolean;
  /** Réfraction coupée pour la session par le garde-fou de fluidité. */
  refractionThrottled: boolean;
  /** Le garde-fou surveille encore la fluidité (pas après une réactivation explicite). */
  frameGuard: boolean;
  material: GlassMaterial;
  refractionActive: boolean;
  lightActive: boolean;
}

interface SessionState {
  refractionThrottled: boolean;
  frameGuard: boolean;
}

const STORAGE_KEY = 'lumiere.appearance';
/** Réfraction coupée par le garde-fou : mémorisé pour l'onglet (survit aux rechargements). */
const THROTTLE_KEY = 'lumiere.refraction-throttled';
const DEFAULTS: AppearancePreferences = { material: 'clear', refraction: true, dynamicLight: true };
const MEDIA = {
  reducedTransparency: '(prefers-reduced-transparency: reduce)',
  moreContrast: '(prefers-contrast: more)',
  reducedMotion: '(prefers-reduced-motion: reduce)',
} as const;

/**
 * Seuls les moteurs Chromium appliquent un filtre SVG (feDisplacementMap) à `backdrop-filter` ;
 * Safari et Firefox affichent alors le verre dépoli sans réfraction.
 */
export function detectRefractionSupport(): boolean {
  if (typeof navigator === 'undefined' || typeof CSS === 'undefined') return false;
  if (!CSS.supports('backdrop-filter', 'url(#lens) blur(2px)')) return false;
  const data = (navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string }> } })
    .userAgentData;
  if (data?.brands) return data.brands.some((entry) => /chromium/i.test(entry.brand));
  const agent = navigator.userAgent;
  // Sans userAgentData (contexte non sécurisé, ex. http://192.168.x.x) : Chrome, Edge, Opera…
  // mais pas les navigateurs iOS, qui reposent tous sur WebKit.
  return /\b(Chrome|Chromium)\/\d+/.test(agent) && !/\b(CriOS|FxiOS|EdgiOS)\//.test(agent);
}

function readPreferences(): AppearancePreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<AppearancePreferences>;
    return {
      material: ['clear', 'tinted', 'solid'].includes(parsed.material as string)
        ? (parsed.material as GlassMaterial)
        : DEFAULTS.material,
      refraction: typeof parsed.refraction === 'boolean' ? parsed.refraction : DEFAULTS.refraction,
      dynamicLight:
        typeof parsed.dynamicLight === 'boolean' ? parsed.dynamicLight : DEFAULTS.dynamicLight,
    };
  } catch {
    return DEFAULTS;
  }
}

function readThrottled(): boolean {
  try {
    return sessionStorage.getItem(THROTTLE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeThrottled(throttled: boolean): void {
  try {
    if (throttled) sessionStorage.setItem(THROTTLE_KEY, '1');
    else sessionStorage.removeItem(THROTTLE_KEY);
  } catch {
    // Stockage de session indisponible : le réglage vaut jusqu'au rechargement.
  }
}

function matches(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : false;
}

function readSystem(): SystemPreferences {
  return {
    reducedTransparency: matches(MEDIA.reducedTransparency),
    moreContrast: matches(MEDIA.moreContrast),
    reducedMotion: matches(MEDIA.reducedMotion),
  };
}

/** État effectif : les réglages d'accessibilité du système priment sur les préférences. */
export function computeAppearance(
  preferences: AppearancePreferences,
  system: SystemPreferences,
  refractionSupported: boolean,
  session: SessionState = { refractionThrottled: false, frameGuard: true },
): AppearanceState {
  const material: GlassMaterial = system.reducedTransparency ? 'solid' : preferences.material;
  return {
    preferences,
    system,
    refractionSupported,
    ...session,
    material,
    refractionActive:
      refractionSupported &&
      preferences.refraction &&
      !session.refractionThrottled &&
      material !== 'solid' &&
      !system.moreContrast,
    lightActive: preferences.dynamicLight && !system.reducedMotion && material !== 'solid',
  };
}

const listeners = new Set<() => void>();
let state: AppearanceState = computeAppearance(DEFAULTS, readSystem(), false);
let initialized = false;

function session(): SessionState {
  return { refractionThrottled: state.refractionThrottled, frameGuard: state.frameGuard };
}

function applyToDocument(next: AppearanceState): void {
  const root = document.documentElement;
  root.dataset.glass = next.material;
  root.dataset.refraction = next.refractionActive ? 'on' : 'off';
  root.dataset.light = next.lightActive ? 'on' : 'off';
}

function update(next: AppearanceState): void {
  state = next;
  applyToDocument(state);
  for (const listener of listeners) listener();
}

/** À appeler une fois au démarrage, avant le premier rendu (évite un flash de style). */
export function initAppearance(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  const supported = detectRefractionSupport();
  const throttled = readThrottled();
  update(
    computeAppearance(readPreferences(), readSystem(), supported, {
      refractionThrottled: throttled,
      frameGuard: !throttled,
    }),
  );
  for (const query of Object.values(MEDIA)) {
    window.matchMedia(query).addEventListener('change', () => {
      update(
        computeAppearance(state.preferences, readSystem(), state.refractionSupported, session()),
      );
    });
  }
  // Préférences modifiées dans un autre onglet.
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY)
      update(
        computeAppearance(readPreferences(), state.system, state.refractionSupported, session()),
      );
  });
}

export function setAppearance(patch: Partial<AppearancePreferences>): void {
  const preferences = { ...state.preferences, ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Stockage indisponible (navigation privée) : réglage valable pour la session.
  }
  // Réactiver explicitement la réfraction lève le garde-fou pour le reste de la session.
  if (patch.refraction === true) writeThrottled(false);
  const next =
    patch.refraction === true ? { refractionThrottled: false, frameGuard: false } : session();
  update(computeAppearance(preferences, state.system, state.refractionSupported, next));
}

/** Coupe la réfraction jusqu'à la fin de la session (affichage trop saccadé). */
export function throttleRefraction(): void {
  writeThrottled(true);
  update(
    computeAppearance(state.preferences, state.system, state.refractionSupported, {
      refractionThrottled: true,
      frameGuard: false,
    }),
  );
}

export function getAppearance(): AppearanceState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppearance(): AppearanceState {
  return useSyncExternalStore(subscribe, getAppearance, getAppearance);
}
