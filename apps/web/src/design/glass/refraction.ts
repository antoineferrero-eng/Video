/**
 * Réfraction Liquid Glass (« lensing ») : le verre courbe la lumière sur ses bords au lieu de
 * simplement la diffuser. On calcule une carte de déplacement pour la forme exacte de chaque
 * élément (rectangle arrondi ou capsule), appliquée à l'arrière-plan par un filtre SVG
 * `feDisplacementMap` référencé dans `backdrop-filter` (pris en charge par Chromium).
 *
 * Profil : un biseau convexe (« squircle ») le long du contour ; les rayons qui le traversent
 * convergent vers l'intérieur, si bien que le contenu proche du bord paraît étiré et courbé,
 * comme à travers l'arête d'un verre épais. L'intérieur, plat, reste net.
 */

export interface LensGeometry {
  width: number;
  height: number;
  /** Rayon des coins (plafonné à la demi-hauteur : capsule). */
  radius: number;
  /** Largeur du biseau réfractif, en pixels CSS. */
  bezel: number;
  /** Déplacement maximal au bord, en pixels CSS. */
  strength: number;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Résolution maximale des cartes : le champ de déplacement est lisse, l'agrandir est sans perte visible. */
const MAX_MAP_SIZE = 320;
const RELEASE_DELAY_MS = 4000;

interface FilterEntry {
  id: string;
  element: SVGFilterElement;
  refs: number;
  releaseTimer: number | undefined;
}

const filters = new Map<string, FilterEntry>();
let defs: SVGDefsElement | null = null;
let counter = 0;

/** Profil du biseau : déplacement maximal au bord, nul au bout du biseau. */
function bezelProfile(t: number): number {
  const inverse = 1 - t;
  return inverse * inverse * (3 - 2 * inverse) * inverse;
}

/**
 * Vecteur de déplacement (composantes dans [-1, 1]) au point (px, py), exprimé en pixels CSS
 * depuis le centre de l'élément : orienté vers l'intérieur dans le biseau, nul ailleurs.
 */
export function lensDisplacement(
  px: number,
  py: number,
  { width, height, radius, bezel }: Omit<LensGeometry, 'strength'>,
): [number, number] {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const corner = Math.min(radius, halfWidth, halfHeight);
  // Distance signée au contour d'un rectangle arrondi (négative à l'intérieur).
  const qx = Math.abs(px) - (halfWidth - corner);
  const qy = Math.abs(py) - (halfHeight - corner);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const depth = -(outside + Math.min(Math.max(qx, qy), 0) - corner);
  if (depth < 0 || depth >= bezel) return [0, 0];

  // Normale sortante du contour (coin arrondi ou côté droit).
  let nx: number;
  let ny: number;
  if (qx > 0 && qy > 0) {
    const length = Math.hypot(qx, qy) || 1;
    nx = (qx / length) * Math.sign(px);
    ny = (qy / length) * Math.sign(py);
  } else if (qx > qy) {
    nx = Math.sign(px);
    ny = 0;
  } else {
    nx = 0;
    ny = Math.sign(py);
  }
  const magnitude = bezelProfile(depth / bezel);
  return [-nx * magnitude || 0, -ny * magnitude || 0];
}

/**
 * Carte de déplacement encodée en image : rouge = déplacement horizontal, vert = vertical
 * (128 = aucun déplacement), vecteurs orientés vers l'intérieur de la forme.
 */
export function createLensMap(geometry: LensGeometry): string {
  const { width, height } = geometry;
  const scale = Math.min(1, MAX_MAP_SIZE / Math.max(width, height));
  const mapWidth = Math.max(2, Math.round(width * scale));
  const mapHeight = Math.max(2, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = mapWidth;
  canvas.height = mapHeight;
  const context = canvas.getContext('2d');
  if (!context) return '';

  const image = context.createImageData(mapWidth, mapHeight);
  const data = image.data;
  for (let y = 0; y < mapHeight; y += 1) {
    for (let x = 0; x < mapWidth; x += 1) {
      // Coordonnées CSS du centre du pixel, relatives au centre de l'élément.
      const [dx, dy] = lensDisplacement(
        (x + 0.5) / scale - width / 2,
        (y + 0.5) / scale - height / 2,
        geometry,
      );
      const offset = (y * mapWidth + x) * 4;
      data[offset] = Math.round(128 + dx * 127);
      data[offset + 1] = Math.round(128 + dy * 127);
      data[offset + 2] = 128;
      data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

function ensureDefs(): SVGDefsElement {
  if (defs?.isConnected) return defs;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'fixed';
  svg.style.pointerEvents = 'none';
  svg.style.visibility = 'hidden';
  defs = document.createElementNS(SVG_NS, 'defs');
  svg.append(defs);
  document.body.append(svg);
  return defs;
}

function createFilter(id: string, geometry: LensGeometry): SVGFilterElement {
  const { width, height, strength } = geometry;
  const filter = document.createElementNS(SVG_NS, 'filter');
  filter.id = id;
  // Région généreuse : si l'élément grandit avant la mise à jour, la zone hors carte reste neutre.
  for (const [name, value] of Object.entries({
    x: '0',
    y: '0',
    width: String(width + 256),
    height: String(height + 256),
    filterUnits: 'userSpaceOnUse',
    primitiveUnits: 'userSpaceOnUse',
    'color-interpolation-filters': 'sRGB',
  }))
    filter.setAttribute(name, value);

  const neutral = document.createElementNS(SVG_NS, 'feFlood');
  neutral.setAttribute('flood-color', 'rgb(128,128,128)');
  neutral.setAttribute('result', 'neutral');

  const map = document.createElementNS(SVG_NS, 'feImage');
  map.setAttribute('href', createLensMap(geometry));
  map.setAttribute('x', '0');
  map.setAttribute('y', '0');
  map.setAttribute('width', String(width));
  map.setAttribute('height', String(height));
  map.setAttribute('preserveAspectRatio', 'none');
  map.setAttribute('result', 'map');

  const field = document.createElementNS(SVG_NS, 'feComposite');
  field.setAttribute('in', 'map');
  field.setAttribute('in2', 'neutral');
  field.setAttribute('operator', 'over');
  field.setAttribute('result', 'field');

  const displacement = document.createElementNS(SVG_NS, 'feDisplacementMap');
  displacement.setAttribute('in', 'SourceGraphic');
  displacement.setAttribute('in2', 'field');
  displacement.setAttribute('scale', String(strength * 2));
  displacement.setAttribute('xChannelSelector', 'R');
  displacement.setAttribute('yChannelSelector', 'G');

  filter.append(neutral, map, field, displacement);
  return filter;
}

/** Fournit (et partage entre éléments de même forme) l'identifiant d'un filtre de réfraction. */
export function acquireLens(geometry: LensGeometry): string {
  const normalized: LensGeometry = {
    width: Math.round(geometry.width),
    height: Math.round(geometry.height),
    radius: Math.round(Math.min(geometry.radius, geometry.width / 2, geometry.height / 2)),
    bezel: Math.round(geometry.bezel),
    strength: Math.round(geometry.strength),
  };
  const key = Object.values(normalized).join('-');
  let entry = filters.get(key);
  if (!entry) {
    counter += 1;
    const id = `lg-lens-${counter}`;
    const element = createFilter(id, normalized);
    ensureDefs().append(element);
    entry = { id, element, refs: 0, releaseTimer: undefined };
    filters.set(key, entry);
  }
  window.clearTimeout(entry.releaseTimer);
  entry.refs += 1;
  return entry.id;
}

/** Libère un filtre ; il est supprimé après un délai s'il n'est plus utilisé. */
export function releaseLens(id: string): void {
  for (const [key, entry] of filters) {
    if (entry.id !== id) continue;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs === 0) {
      entry.releaseTimer = window.setTimeout(() => {
        if (entry.refs > 0) return;
        entry.element.remove();
        filters.delete(key);
      }, RELEASE_DELAY_MS);
    }
    return;
  }
}

/** Nombre de filtres actifs (diagnostic et tests). */
export function activeLensCount(): number {
  return filters.size;
}
