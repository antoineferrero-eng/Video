import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { findDate, findSize, parseDateValue, parseSizeExact } from './listing-dates';

/**
 * Analyseur générique de listings de dossiers HTTP.
 *
 * Plutôt que de dépendre d'un format précis (le HTML exact de la source peut évoluer),
 * il repère les liens qui pointent vers des enfants directs du dossier courant, puis
 * déduit taille et date de la « ligne » qui entoure chaque lien. Formats couverts :
 * nginx/Apache (autoindex `<pre>` ou `<table>`), Caddy, lighttpd, h5ai-like, listes `<ul>`,
 * grilles `<div>` personnalisées et listings JSON (nginx `autoindex_format json`, Caddy, rclone).
 */

export interface ListingItem {
  name: string;
  isDirectory: boolean;
  size: number | null;
  modifiedAt: string | null;
}

export type ListingFormat = 'json' | 'table' | 'pre' | 'list' | 'generic';

export interface ParsedListing {
  items: ListingItem[];
  format: ListingFormat;
}

export function parseListing(
  body: string,
  pageUrl: URL,
  contentType: string | null = null,
): ParsedListing {
  const trimmed = body.trimStart();
  if (contentType?.includes('json') || trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const items = parseJsonListing(trimmed);
    if (items) return { items, format: 'json' };
  }
  return parseHtmlListing(body, pageUrl);
}

// ---------------------------------------------------------------------------
// Résolution des liens
// ---------------------------------------------------------------------------

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function decodePathname(pathname: string): string {
  return pathname.split('/').map(safeDecode).join('/');
}

interface ChildLink {
  key: string;
  name: string;
  isDirectory: boolean;
}

function resolveChild(href: string, pageUrl: URL, basePath: string): ChildLink | null {
  const raw = href.trim();
  if (
    !raw ||
    raw.startsWith('#') ||
    raw.startsWith('?') ||
    /^(javascript|mailto|data|tel):/i.test(raw)
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw, pageUrl);
  } catch {
    return null;
  }
  if (url.origin !== pageUrl.origin) return null;
  const target = decodePathname(url.pathname);
  if (!target.startsWith(basePath)) return null;
  const rest = target.slice(basePath.length);
  const isDirectory = rest.endsWith('/');
  const name = isDirectory ? rest.slice(0, -1) : rest;
  if (!name || name.includes('/') || name === '.' || name === '..' || name.startsWith('.'))
    return null;
  return { key: name + (isDirectory ? '/' : ''), name, isDirectory };
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function parseHtmlListing(html: string, pageUrl: URL): ParsedListing {
  // htmlparser2 (mode « xml » désactivé) : bien plus rapide que parse5 sur les très gros listings.
  const $ = cheerio.load(html, { xml: { xmlMode: false, decodeEntities: true } });
  const pagePath = pageUrl.pathname.endsWith('/') ? pageUrl.pathname : `${pageUrl.pathname}/`;
  const basePath = decodePathname(pagePath);
  // Les liens relatifs se résolvent par rapport au dossier (URL avec slash final).
  const baseUrl = new URL(pagePath, pageUrl);

  const anchorKeys = new Map<Element, string>();
  const entries = new Map<string, { link: ChildLink; anchors: Element[] }>();

  for (const anchor of $('a[href]').toArray()) {
    const link = resolveChild($(anchor).attr('href') ?? '', baseUrl, basePath);
    if (!link) continue;
    anchorKeys.set(anchor, link.key);
    const existing = entries.get(link.key);
    if (existing) existing.anchors.push(anchor);
    else entries.set(link.key, { link, anchors: [anchor] });
  }

  const votes: Record<Exclude<ListingFormat, 'json'>, number> = {
    table: 0,
    pre: 0,
    list: 0,
    generic: 0,
  };
  const headerCache = new Map<Element, HeaderIndex>();
  const items: ListingItem[] = [];

  for (const { link, anchors } of entries.values()) {
    const anchor = anchors.at(-1) as Element;
    const details = extractDetails(anchor, link, anchorKeys, headerCache);
    votes[details.format] += 1;
    items.push({
      name: link.name,
      isDirectory: link.isDirectory,
      size: link.isDirectory && details.size === 0 ? null : details.size,
      modifiedAt: details.modifiedAt,
    });
  }

  const format = (Object.entries(votes) as Array<[ListingFormat, number]>).reduce(
    (best, current) => (current[1] > best[1] ? current : best),
    ['generic', 0] as [ListingFormat, number],
  )[0];
  return { items, format };
}

interface Details {
  size: number | null;
  modifiedAt: string | null;
  format: Exclude<ListingFormat, 'json'>;
}

function isElement(node: AnyNode | null | undefined): node is Element {
  return !!node && (node.type === 'tag' || node.type === 'script' || node.type === 'style');
}

/** Équivalent de `closest()` sans passer par le moteur de sélecteurs (coûteux sur 50 000 lignes). */
function closestByName(node: Element, name: string): Element | null {
  let current: AnyNode | null = node;
  while (current) {
    if (isElement(current) && current.name === name) return current;
    current = current.parent;
  }
  return null;
}

function nodeText(node: AnyNode): string {
  if (node.type === 'text') return (node as unknown as { data: string }).data;
  if (isElement(node)) return node.children.map(nodeText).join('');
  return '';
}

function extractDetails(
  anchor: Element,
  link: ChildLink,
  anchorKeys: Map<Element, string>,
  headerCache: Map<Element, HeaderIndex>,
): Details {
  const { key } = link;
  const row = findRow(anchor, key, anchorKeys);

  if (!row) {
    const inPre = closestByName(anchor, 'pre') !== null;
    const text = textAfterAnchor(anchor);
    const date = findDate(text);
    const remainder = date
      ? text.slice(0, date.index) + ' ' + text.slice(date.index + date.length)
      : text;
    return {
      size: findSize(remainder),
      modifiedAt: date?.iso ?? null,
      format: inPre ? 'pre' : 'generic',
    };
  }

  if (row.name === 'tr')
    return { ...extractFromTableRow(row, key, anchorKeys, headerCache), format: 'table' };
  return {
    ...extractFromGenericRow(row, link, anchorKeys),
    format: row.name === 'li' ? 'list' : 'generic',
  };
}

/**
 * Remonte depuis le lien jusqu'au plus grand ancêtre ne contenant qu'une seule entrée :
 * c'est la « ligne » qui porte taille et date.
 */
function findRow(anchor: Element, key: string, anchorKeys: Map<Element, string>): Element | null {
  let row: Element | null = null;
  let current: Element | null = anchor;
  while (current && current.name !== 'body' && current.name !== 'html') {
    if (containsOtherEntry(current, key, anchorKeys)) break;
    row = current;
    if (current.name === 'tr' || current.name === 'li') break;
    current = isElement(current.parent) ? current.parent : null;
  }
  // Un simple <a> sans contenu additionnel n'est pas une ligne exploitable.
  if (row === anchor && !hasExtraContent(anchor)) return null;
  return row;
}

function containsOtherEntry(node: AnyNode, key: string, anchorKeys: Map<Element, string>): boolean {
  // Parcours en profondeur avec sortie anticipée : reste linéaire même pour un <pre> de 50 000 liens.
  if (!isElement(node)) return false;
  if (node.name === 'a') {
    const other = anchorKeys.get(node);
    if (other !== undefined && other !== key) return true;
  }
  for (const child of node.children) {
    if (containsOtherEntry(child, key, anchorKeys)) return true;
  }
  return false;
}

function hasExtraContent(anchor: Element): boolean {
  return anchor.children.some(
    (child) => isElement(child) && child.children.length > 0 && nodeText(child).trim() !== '',
  );
}

/** Texte suivant un lien jusqu'à la fin de la ligne (listings `<pre>` nginx/Apache). */
function textAfterAnchor(anchor: Element): string {
  let text = '';
  let node: AnyNode | null = anchor.nextSibling;
  while (node) {
    if (isElement(node) && node.name === 'a') break;
    text += nodeText(node);
    if (text.includes('\n')) break;
    node = node.nextSibling;
  }
  return text.split('\n')[0] ?? '';
}

interface HeaderIndex {
  size: number | null;
  date: number | null;
}

/** Première ligne d'en-tête (<tr> contenant des <th>) d'un tableau, sans parcourir tout le DOM. */
function findHeaderRow(table: Element): Element | null {
  const stack: AnyNode[] = [];
  for (let index = table.children.length - 1; index >= 0; index -= 1) {
    stack.push(table.children[index] as AnyNode);
  }
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isElement(node) || node.name === 'table') continue;
    if (node.name === 'tr') {
      if (node.children.some((child) => isElement(child) && child.name === 'th')) return node;
      continue;
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index] as AnyNode);
    }
  }
  return null;
}

function headerIndexFor(table: Element, cache: Map<Element, HeaderIndex>): HeaderIndex {
  const cached = cache.get(table);
  if (cached) return cached;
  const index: HeaderIndex = { size: null, date: null };
  const cells = (findHeaderRow(table)?.children ?? []).filter(
    (child): child is Element => isElement(child) && (child.name === 'th' || child.name === 'td'),
  );
  cells.forEach((cell, position) => {
    const label = nodeText(cell).trim().toLowerCase();
    if (index.size === null && /size|taille|gr(ö|o)(ss|ß)e|tama|dimensione|poids/.test(label)) {
      index.size = position;
    } else if (index.date === null && /modif|date|time|updated|mtime|last|derni/.test(label)) {
      index.date = position;
    }
  });
  cache.set(table, index);
  return index;
}

function cellAttributes(cell: Element): string[] {
  const values: string[] = [];
  const visit = (node: AnyNode) => {
    if (!isElement(node)) return;
    for (const attr of [
      'data-sort',
      'data-value',
      'data-size',
      'data-bytes',
      'data-order',
      'data-time',
      'data-mtime',
      'data-date',
      'datetime',
      'title',
    ]) {
      const value = node.attribs[attr];
      if (value) values.push(value);
    }
    node.children.forEach(visit);
  };
  visit(cell);
  return values;
}

function sizeFromCell(cell: Element): number | null {
  const fromText = parseSizeExact(nodeText(cell));
  if (fromText !== null) return fromText;
  for (const value of cellAttributes(cell)) {
    const size = /^\d+$/.test(value.trim()) ? Number(value) : parseSizeExact(value);
    if (size !== null) return size;
  }
  return null;
}

function dateFromCell(cell: Element): string | null {
  // Les attributs (datetime, data-*) sont plus fiables que le texte affiché (format localisé).
  for (const value of cellAttributes(cell)) {
    const date = parseDateValue(value);
    if (date) return date;
  }
  return parseDateValue(nodeText(cell));
}

function extractFromTableRow(
  row: Element,
  key: string,
  anchorKeys: Map<Element, string>,
  headerCache: Map<Element, HeaderIndex>,
): Omit<Details, 'format'> {
  const cells = row.children.filter(
    (child): child is Element => isElement(child) && (child.name === 'td' || child.name === 'th'),
  );
  const table = closestByName(row, 'table');
  const header = table ? headerIndexFor(table, headerCache) : { size: null, date: null };

  let size: number | null = null;
  let modifiedAt: string | null = null;
  if (header.size !== null && cells[header.size])
    size = sizeFromCell(cells[header.size] as Element);
  if (header.date !== null && cells[header.date])
    modifiedAt = dateFromCell(cells[header.date] as Element);

  if (size === null || modifiedAt === null) {
    for (const cell of cells) {
      if (cellContainsEntry(cell, key, anchorKeys)) continue;
      const text = nodeText(cell).trim();
      if (modifiedAt === null && text && findDate(text)) {
        modifiedAt = dateFromCell(cell);
        continue;
      }
      if (size === null && text) size = parseSizeExact(text);
    }
  }
  return { size, modifiedAt };
}

function cellContainsEntry(cell: Element, key: string, anchorKeys: Map<Element, string>): boolean {
  const stack: AnyNode[] = [cell];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isElement(node)) continue;
    if (node.name === 'a' && anchorKeys.get(node) === key) return true;
    stack.push(...node.children);
  }
  return false;
}

function extractFromGenericRow(
  row: Element,
  link: ChildLink,
  anchorKeys: Map<Element, string>,
): Omit<Details, 'format'> {
  const { key } = link;
  const loweredName = link.name.toLowerCase();
  const texts: string[] = [];
  const visit = (node: AnyNode, insideEntryAnchor: boolean) => {
    if (node.type === 'text') {
      if (!insideEntryAnchor) {
        const text = (node as unknown as { data: string }).data.trim();
        // Le nom de l'entrée (répété dans la ligne) ne doit pas être pris pour une taille/date.
        if (text && !text.toLowerCase().includes(loweredName)) texts.push(text);
      }
      return;
    }
    if (!isElement(node)) return;
    const isEntryAnchor = node.name === 'a' && anchorKeys.get(node) === key;
    // Si la ligne est le lien lui-même, on garde le contenu de ses enfants hors nom.
    const hidden = insideEntryAnchor || (isEntryAnchor && node !== row);
    for (const child of node.children) visit(child, hidden);
  };
  visit(row, false);

  const attributes = cellAttributes(row);
  let modifiedAt: string | null = null;
  let size: number | null = null;
  for (const text of texts) {
    if (modifiedAt === null) {
      const date = parseDateValue(text);
      if (date) {
        modifiedAt = date;
        continue;
      }
    }
    if (size === null) size = parseSizeExact(text);
  }
  if (modifiedAt === null) {
    for (const value of attributes) {
      const date = parseDateValue(value);
      if (date) {
        modifiedAt = date;
        break;
      }
    }
  }
  if (size === null && !link.isDirectory) {
    const joined = texts.join('  ');
    const date = findDate(joined);
    size = findSize(
      date ? joined.slice(0, date.index) + ' ' + joined.slice(date.index + date.length) : joined,
    );
  }
  return { size, modifiedAt };
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function asRecordArray(data: unknown): JsonRecord[] | null {
  if (Array.isArray(data))
    return data.filter((item): item is JsonRecord => !!item && typeof item === 'object');
  if (data && typeof data === 'object') {
    const record = data as JsonRecord;
    for (const key of ['files', 'items', 'entries', 'content', 'children', 'data']) {
      const nested = asRecordArray(record[key]);
      if (nested) return nested;
    }
  }
  return null;
}

function parseJsonListing(body: string): ListingItem[] | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  const records = asRecordArray(data);
  if (!records) return null;

  const items: ListingItem[] = [];
  for (const record of records) {
    const rawName = [record.name, record.Name, record.filename, record.title].find(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    if (!rawName) continue;
    const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
    const isDirectory =
      record.is_dir === true ||
      record.isDir === true ||
      record.IsDir === true ||
      ['directory', 'dir', 'folder'].includes(type) ||
      record.mimeType === 'application/vnd.google-apps.folder' ||
      rawName.endsWith('/');
    const name = rawName.replace(/\/+$/, '');
    if (!name || name.startsWith('.') || name.includes('/')) continue;
    const rawSize = record.size ?? record.Size ?? record.length;
    const size =
      typeof rawSize === 'number'
        ? rawSize
        : typeof rawSize === 'string'
          ? parseSizeExact(rawSize)
          : null;
    const rawDate = [
      record.mtime,
      record.mod_time,
      record.ModTime,
      record.modified,
      record.modifiedTime,
      record.last_modified,
      record.updated_at,
      record.date,
    ].find((value) => typeof value === 'string' || typeof value === 'number');
    items.push({
      name,
      isDirectory,
      size: isDirectory ? null : size,
      modifiedAt: rawDate === undefined ? null : parseDateValue(String(rawDate)),
    });
  }
  return items;
}
