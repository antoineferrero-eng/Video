import type { ReleaseInfo } from '@lumiere/shared';
import { classifyFile, stripExtension } from './media-files';

/** Délimiteurs de « mots » dans un nom de release (points, tirets, espaces…). */
const B = '(?<![a-z0-9])';
const E = '(?![a-z0-9])';
const token = (body: string) => new RegExp(`${B}(?:${body})${E}`, 'i');
/** Variante autorisant des chiffres collés à droite (« DDP5.1 », « AAC2.0 »). */
const codecToken = (body: string) => new RegExp(`${B}(?:${body})(?![a-z])`, 'i');

type Rule = [RegExp, string];

const RESOLUTIONS: Rule[] = [
  [token('2160p|4k|uhd'), '2160p'],
  [token('1440p'), '1440p'],
  [token('1080[pi]'), '1080p'],
  [token('720p'), '720p'],
  [token('576p'), '576p'],
  [token('480p'), '480p'],
  [token('360p'), '360p'],
];

const SOURCES: Rule[] = [
  [token('remux|bdremux'), 'Remux'],
  [token('blu-?ray|bdrip|brrip|bd|bdmv|bd25|bd50'), 'BluRay'],
  [token('web-?dl'), 'WEB-DL'],
  [token('web-?rip'), 'WEBRip'],
  [token('hdlight|mhd'), 'HDLight'],
  [token('web'), 'WEB'],
  [token('hdtv|pdtv|tvrip'), 'HDTV'],
  [token('dvd-?rip'), 'DVDRip'],
  [token('dvd|dvd5|dvd9|dvdr'), 'DVD'],
  [token('hdrip'), 'HDRip'],
  [token('hd-?cam|cam-?rip|cam|telesync|hdts'), 'CAM'],
];

const VIDEO_CODECS: Rule[] = [
  [token('x265|h[ .]?265|hevc'), 'H.265'],
  [token('x264|h[ .]?264|avc'), 'H.264'],
  [token('av1'), 'AV1'],
  [token('vp9'), 'VP9'],
  [token('xvid|divx'), 'XviD'],
  [token('mpeg-?2'), 'MPEG-2'],
  [token('vc-?1'), 'VC-1'],
];

const AUDIO_CODECS: Rule[] = [
  [codecToken('truehd'), 'TrueHD'],
  [codecToken('dts-?hd[ .-]?ma|dts-?ma'), 'DTS-HD MA'],
  [codecToken('dts-?x'), 'DTS:X'],
  [codecToken('dts-?hd'), 'DTS-HD'],
  [codecToken('dts'), 'DTS'],
  [codecToken('ddp|dd\\+|e-?ac-?3'), 'DD+'],
  [codecToken('dd|ac-?3'), 'DD'],
  [codecToken('aac'), 'AAC'],
  [codecToken('flac'), 'FLAC'],
  [codecToken('opus'), 'Opus'],
  [codecToken('mp3'), 'MP3'],
  [codecToken('l?pcm'), 'PCM'],
];

const LANGUAGES: Rule[] = [
  [token('multi'), 'MULTi'],
  [token('truefrench'), 'TRUEFRENCH'],
  [token('vff'), 'VFF'],
  [token('vfq'), 'VFQ'],
  [token('vfi'), 'VFI'],
  [token('vf2'), 'VF2'],
  [token('vof'), 'VOF'],
  [token('vf'), 'VF'],
  [token('vostfr|subfrench|stfr'), 'VOSTFR'],
  [token('french|fr'), 'FRENCH'],
  [token('vost|vo'), 'VO'],
  [token('english|eng'), 'ENGLISH'],
];

const SERVICES: Rule[] = [
  [token('nf|netflix'), 'Netflix'],
  [token('amzn|amazon'), 'Prime Video'],
  [token('dsnp|dsny|disney\\+?'), 'Disney+'],
  [token('atvp|aptv'), 'Apple TV+'],
  [token('hmax'), 'Max'],
  [token('hulu'), 'Hulu'],
  [token('pcok'), 'Peacock'],
  [token('pmtp'), 'Paramount+'],
  [token('crav'), 'Crave'],
  [token('adn'), 'ADN'],
  [token('mycanal|cnlp'), 'Canal+'],
];

const EDITIONS: Rule[] = [
  [token('extended(?:[ .-]?(?:cut|edition))?'), 'Version longue'],
  [token("director'?s[ .-]?cut|dc"), "Director's Cut"],
  [token('unrated|uncut'), 'Non censuré'],
  [token('remaster(?:ed)?'), 'Remasterisé'],
  [token('imax'), 'IMAX'],
  [token('theatrical'), 'Version cinéma'],
  [token('criterion'), 'Criterion'],
  [token('final[ .-]?cut'), 'Final Cut'],
];

/** Marqueurs indiquant le début de la partie « technique » du nom. */
const TECH_MARKERS: RegExp[] = [
  ...RESOLUTIONS.map(([pattern]) => pattern),
  ...SOURCES.map(([pattern]) => pattern),
  ...VIDEO_CODECS.map(([pattern]) => pattern),
  token('s\\d{1,3}(?:[ ._-]?e\\d{1,4})?'),
  token('\\d{1,2}x\\d{2,3}'),
  token('multi|truefrench|french|vff|vfq|vfi|vf2|vostfr|subfrench'),
  token('complete|integrale|int[ée]grale|saison|season'),
  token('10bit|10bits|hdr10|hdr|dv'),
];

const GROUP_DENYLIST = /^(dl|rip|hd|ma|x|dts|hdr|web|sdr|ac3|aac|mkv|mp4|vff|vf|multi)$/i;

function firstMatch(rules: Rule[], text: string): string | null {
  for (const [pattern, label] of rules) {
    if (pattern.test(text)) return label;
  }
  return null;
}

function allMatches(rules: Rule[], text: string): string[] {
  const labels: string[] = [];
  for (const [pattern, label] of rules) {
    if (pattern.test(text) && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/[._]+/g, ' ')
    .replace(/\s*[-([{]+\s*$/g, '')
    .replace(/^\s*[-)\]}]+\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface TitleSplit {
  title: string;
  year: number | null;
  tail: string;
}

/** Sépare le titre (et l'année) de la partie technique d'un nom de release. */
export function splitTitle(stem: string): TitleSplit {
  let techIndex = -1;
  for (const marker of TECH_MARKERS) {
    const match = marker.exec(stem);
    if (match && match.index > 0 && (techIndex === -1 || match.index < techIndex)) {
      techIndex = match.index;
    }
  }

  const years = [...stem.matchAll(/(?<![0-9])((?:19|20)\d{2})(?![0-9])/g)].filter(
    (match) => match.index > 0 && (techIndex === -1 || match.index <= techIndex),
  );
  const yearMatch = years.at(-1);

  if (yearMatch) {
    const title = cleanTitle(stem.slice(0, yearMatch.index));
    if (title) {
      return { title, year: Number(yearMatch[1]), tail: stem.slice(yearMatch.index) };
    }
  }
  const end = techIndex === -1 ? stem.length : techIndex;
  const title = cleanTitle(stem.slice(0, end)) || cleanTitle(stem);
  return { title, year: null, tail: techIndex === -1 ? '' : stem.slice(techIndex) };
}

function parseAudio(tail: string): string | null {
  for (const [pattern, label] of AUDIO_CODECS) {
    const match = pattern.exec(tail);
    if (!match) continue;
    const after = tail.slice(match.index + match[0].length);
    const adjacent = /^[ .-]?(?:ma[ .-]?)?(?:atmos[ .-]?)?([1-9])[ .]([0-2])(?![0-9])/i.exec(after);
    const generic = /(?<![0-9.])([1-7])\.([0-2])(?![0-9.])/.exec(tail);
    const channels = adjacent ?? generic;
    const atmos = token('atmos').test(tail) ? ' Atmos' : '';
    return `${label}${atmos}${channels ? ` ${channels[1]}.${channels[2]}` : ''}`;
  }
  return token('atmos').test(tail) ? 'Atmos' : null;
}

function parseHdr(tail: string): string | null {
  const parts: string[] = [];
  if (token('dv|dovi|dolby[ .-]?vision').test(tail)) parts.push('Dolby Vision');
  if (token('hdr10\\+|hdr10plus|hdr10p').test(tail)) parts.push('HDR10+');
  else if (token('hdr10').test(tail)) parts.push('HDR10');
  else if (token('hdr').test(tail)) parts.push('HDR');
  return parts.length > 0 ? parts.join(' · ') : null;
}

function parseGroup(stem: string): string | null {
  const withoutBrackets = stem.replace(/\s*\[[^\]]*\]\s*$/, '');
  const match = /-([A-Za-z0-9][A-Za-z0-9_]{1,30})$/.exec(withoutBrackets);
  if (!match?.[1] || GROUP_DENYLIST.test(match[1])) return null;
  return match[1];
}

export interface ParsedRelease {
  title: string;
  year: number | null;
  info: ReleaseInfo;
}

/** Analyse un nom de release (fichier ou dossier) : titre, année et caractéristiques techniques. */
export function parseRelease(name: string): ParsedRelease {
  const stem = classifyFile(name) === 'other' ? name : stripExtension(name);
  const { title, year, tail } = splitTitle(stem);
  return {
    title,
    year,
    info: {
      resolution: firstMatch(RESOLUTIONS, tail),
      source: firstMatch(SOURCES, tail),
      videoCodec: firstMatch(VIDEO_CODECS, tail),
      audioCodec: parseAudio(tail),
      hdr: parseHdr(tail),
      languages: allMatches(LANGUAGES, tail),
      service: firstMatch(SERVICES, tail),
      edition: firstMatch(EDITIONS, tail),
      group: tail ? parseGroup(stem) : null,
    },
  };
}

export function emptyReleaseInfo(): ReleaseInfo {
  return {
    resolution: null,
    source: null,
    videoCodec: null,
    audioCodec: null,
    hdr: null,
    languages: [],
    service: null,
    edition: null,
    group: null,
  };
}

const RESOLUTION_RANK: Record<string, number> = {
  '2160p': 6,
  '1440p': 5,
  '1080p': 4,
  '720p': 3,
  '576p': 2,
  '480p': 1,
  '360p': 0,
};

export function resolutionRank(resolution: string | null): number {
  return resolution ? (RESOLUTION_RANK[resolution] ?? -1) : -1;
}
