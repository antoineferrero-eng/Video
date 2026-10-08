/**
 * Faux service TMDB pour la démonstration hors ligne : mêmes routes et même format JSON
 * que l'API v3 de The Movie Database, pour exercer le vrai code d'enrichissement
 * (recherche, détails, saisons, cache des images) sans accès à Internet.
 */
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';

interface DemoEpisode {
  name: string;
  overview: string;
}

export interface DemoTitle {
  id: number;
  kind: 'movie' | 'tv';
  /** Identifiant IMDb (fictif) : c'est lui qu'attend l'extension Stremio de démonstration. */
  imdb: string;
  /** Dossier du titre dans la source de démonstration (absent : pas de fichier). */
  folder?: string;
  title: string;
  /** Titre anglais (requêtes en en-US), s'il diffère du titre affiché. */
  englishTitle?: string;
  originalTitle: string;
  date: string;
  overview: string;
  tagline: string;
  genres: string[];
  runtime: number;
  rating: number;
  colors: [string, string];
  seasons?: Record<number, DemoEpisode[]>;
}

export const DEMO_TITLES: DemoTitle[] = [
  {
    id: 1001,
    kind: 'movie',
    imdb: 'tt9100101',
    folder: 'Big Buck Moon (2024)',
    title: 'Big Buck Moon',
    originalTitle: 'Big Buck Moon',
    date: '2024-06-12',
    overview:
      "Un lapin géant découvre la face cachée de la Lune et décide d'y planter le plus grand potager de l'univers, au grand dam des astronautes venus l'en déloger.",
    tagline: "La Lune n'a qu'à bien se tenir.",
    genres: ['Animation', 'Aventure', 'Comédie'],
    runtime: 92,
    rating: 7.6,
    colors: ['0x0f766e', '0xfbbf24'],
  },
  {
    id: 1002,
    kind: 'movie',
    imdb: 'tt9100102',
    folder: 'Le Voyage Imaginaire (2023)',
    title: 'Le Voyage imaginaire',
    originalTitle: 'Le Voyage Imaginaire',
    date: '2023-11-08',
    overview:
      "Une cartographe insomniaque trouve un atlas dont les pages dessinent les rêves de ceux qui le lisent. Pour sauver son frère, elle devra traverser des pays qui n'existent que la nuit.",
    tagline: 'Chaque rêve a sa carte.',
    genres: ['Aventure', 'Fantastique'],
    runtime: 118,
    rating: 8.1,
    colors: ['0x4c1d95', '0xf472b6'],
  },
  {
    id: 1003,
    kind: 'movie',
    imdb: 'tt9100103',
    folder: 'COSMOS ODYSSEY (2025)',
    title: 'Cosmos Odyssey',
    originalTitle: 'Cosmos Odyssey',
    date: '2025-03-19',
    overview:
      "Aux confins du système solaire, l'équipage du Kepler capte un signal venu d'ailleurs. Rentrer sur Terre ou répondre : chacun devra choisir ce qu'il est prêt à sacrifier.",
    tagline: "Le silence n'est jamais vide.",
    genres: ['Science-Fiction', 'Drame'],
    runtime: 141,
    rating: 7.9,
    colors: ['0x020617', '0x38bdf8'],
  },
  {
    id: 1004,
    kind: 'movie',
    imdb: 'tt9100104',
    folder: 'Nuit Blanche (2022)',
    title: 'Nuit blanche',
    originalTitle: 'Nuit Blanche',
    date: '2022-07-06',
    overview:
      "Paris, une nuit d'été. Un chauffeur de taxi accepte une course qui va l'entraîner, d'arrondissement en arrondissement, au cœur d'une affaire qui le dépasse.",
    tagline: 'Personne ne dort cette nuit.',
    genres: ['Thriller', 'Crime'],
    runtime: 101,
    rating: 7.1,
    colors: ['0x111827', '0xef4444'],
  },
  {
    id: 1005,
    kind: 'movie',
    imdb: 'tt9100105',
    folder: 'Le Dernier Train (2021)',
    title: 'Le Dernier Train',
    originalTitle: 'Le Dernier Train',
    date: '2021-02-17',
    overview:
      "Deux inconnus montent dans le dernier train de la nuit. Le temps d'un trajet entre Lyon et Marseille, ils vont se raconter ce qu'ils n'ont jamais osé dire à personne.",
    tagline: "Certaines rencontres n'arrivent qu'une fois.",
    genres: ['Drame', 'Romance'],
    runtime: 109,
    rating: 7.4,
    colors: ['0x7c2d12', '0xfde68a'],
  },
  {
    // Présent sur TMDB mais absent de la source : « Introuvable sur la source ».
    id: 1006,
    kind: 'movie',
    imdb: 'tt9100106',
    title: 'L’Éclipse oubliée',
    englishTitle: 'The Forgotten Eclipse',
    originalTitle: 'The Forgotten Eclipse',
    date: '2024-10-02',
    overview:
      'Une astronome amateur photographie une éclipse que personne d’autre n’a vue. Les archives, elles, gardent la trace d’une autre, survenue cent ans plus tôt jour pour jour.',
    tagline: 'Le ciel se souvient.',
    genres: ['Mystère', 'Science-Fiction'],
    runtime: 104,
    rating: 6.9,
    colors: ['0x0c0a09', '0xf59e0b'],
  },
  {
    id: 2001,
    kind: 'tv',
    imdb: 'tt9100201',
    folder: 'Les Explorateurs',
    title: 'Les Explorateurs',
    originalTitle: 'Les Explorateurs',
    date: '2023-03-10',
    overview:
      'Une équipe de jeunes scientifiques parcourt les recoins inexplorés de la planète, des fosses océaniques aux volcans endormis, et découvre que la Terre garde encore bien des secrets.',
    tagline: 'Là où les cartes s’arrêtent.',
    genres: ['Aventure', 'Science-Fiction'],
    runtime: 42,
    rating: 8.3,
    colors: ['0x064e3b', '0x34d399'],
    seasons: {
      1: [
        { name: 'Le Départ', overview: "L'équipe embarque pour une expédition de deux ans." },
        {
          name: 'Les Abysses',
          overview: 'Une plongée à 6 000 mètres révèle une forme de vie inconnue.',
        },
        {
          name: 'Le Volcan endormi',
          overview: 'Un réveil inattendu bouleverse les plans de la mission.',
        },
      ],
      2: [
        { name: 'Retour à la surface', overview: 'Un an plus tard, les explorateurs repartent.' },
      ],
    },
  },
  {
    id: 2002,
    kind: 'tv',
    imdb: 'tt9100202',
    folder: 'Orbite (2020)',
    title: 'Orbite',
    originalTitle: 'Orbite',
    date: '2020-09-15',
    overview:
      'À bord d’une station spatiale en perdition, sept astronautes tentent de survivre tandis que, sur Terre, plus personne ne répond.',
    tagline: 'À 400 km au-dessus de nos têtes.',
    genres: ['Science-Fiction', 'Mystère'],
    runtime: 38,
    rating: 7.7,
    colors: ['0x1e1b4b', '0xa78bfa'],
    seasons: {
      1: [
        { name: 'Décollage', overview: 'Le lancement de la mission Orbite tourne au cauchemar.' },
        { name: 'Silence radio', overview: 'Les communications avec la Terre sont coupées.' },
      ],
    },
  },
];

export const posterFile = (title: DemoTitle) => `demo-poster-${title.id}.jpg`;
export const backdropFile = (title: DemoTitle) => `demo-backdrop-${title.id}.jpg`;
export const stillFile = (title: DemoTitle, season: number, episode: number) =>
  `demo-still-${title.id}-${season}-${episode}.jpg`;

const normalize = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Genres numérotés une fois pour toutes (comme `/genre/movie/list`). */
const GENRE_IDS = new Map(
  [...new Set(DEMO_TITLES.flatMap((title) => title.genres))].map((name, index) => [
    name,
    100 + index,
  ]),
);

function genres(title: DemoTitle) {
  return title.genres.map((name) => ({ id: GENRE_IDS.get(name) ?? 0, name }));
}

/** Popularité TMDB fictive : chaque titre a la sienne, pour que le tri par popularité se voie. */
const POPULARITY: Record<string, number> = {
  tt9100103: 412.7,
  tt9100201: 288.4,
  tt9100102: 196.2,
  tt9100105: 141.9,
  tt9100202: 97.3,
  tt9100101: 64.8,
  tt9100104: 38.5,
  tt9100106: 12.1,
};

function summary(title: DemoTitle, language = 'fr-FR') {
  const shown = language.startsWith('en') && title.englishTitle ? title.englishTitle : title.title;
  const common = {
    id: title.id,
    overview: title.overview,
    poster_path: `/${posterFile(title)}`,
    backdrop_path: `/${backdropFile(title)}`,
    vote_average: title.rating,
    vote_count: 1000 + title.id,
    popularity: POPULARITY[title.imdb] ?? 10,
    genre_ids: title.genres.map((name) => GENRE_IDS.get(name) ?? 0),
  };
  return title.kind === 'movie'
    ? {
        ...common,
        title: shown,
        original_title: title.originalTitle,
        release_date: title.date,
      }
    : {
        ...common,
        name: shown,
        original_name: title.originalTitle,
        first_air_date: title.date,
      };
}

function details(title: DemoTitle, language: string) {
  const base = { ...summary(title, language), tagline: title.tagline, genres: genres(title) };
  return title.kind === 'movie'
    ? { ...base, runtime: title.runtime }
    : {
        ...base,
        episode_run_time: [title.runtime],
        seasons: Object.entries(title.seasons ?? {}).map(([number, episodes]) => ({
          season_number: Number(number),
          episode_count: episodes.length,
          name: `Saison ${number}`,
          air_date: title.date,
          poster_path: `/${posterFile(title)}`,
          overview: '',
        })),
      };
}

function season(title: DemoTitle, number: number) {
  const episodes = title.seasons?.[number];
  if (!episodes) return null;
  return {
    season_number: number,
    name: `Saison ${number}`,
    overview: number === 1 ? `La première saison de ${title.title}.` : '',
    poster_path: `/${posterFile(title)}`,
    episodes: episodes.map((episode, index) => ({
      episode_number: index + 1,
      name: episode.name,
      overview: episode.overview,
      still_path: `/${stillFile(title, number, index + 1)}`,
      air_date: title.date,
      runtime: title.runtime,
    })),
  };
}

function send(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

/** Traite une requête /tmdb/3/… ou /tmdb-images/… ; renvoie false si la route n'est pas concernée. */
export function handleFakeTmdb(
  url: URL,
  headers: http.IncomingHttpHeaders,
  response: http.ServerResponse,
  imagesDir: string,
): boolean {
  const imageMatch = /^\/tmdb-images\/[a-z0-9]+\/([A-Za-z0-9_-]+\.jpg)$/.exec(url.pathname);
  if (imageMatch?.[1]) {
    const file = path.join(imagesDir, imageMatch[1]);
    if (!fs.existsSync(file)) {
      response.writeHead(404).end();
      return true;
    }
    response.writeHead(200, { 'content-type': 'image/jpeg' });
    fs.createReadStream(file).pipe(response);
    return true;
  }
  if (!url.pathname.startsWith('/tmdb/3/')) return false;

  const key = url.searchParams.get('api_key') ?? headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!key || key === 'invalid') {
    send(response, 401, {
      status_code: 7,
      status_message: 'Invalid API key: You must be granted a valid key.',
    });
    return true;
  }
  const route = url.pathname.slice('/tmdb/3'.length);
  if (route === '/configuration') {
    send(response, 200, { images: { secure_base_url: '/tmdb-images/' } });
    return true;
  }
  const search = /^\/search\/(movie|tv)$/.exec(route);
  if (search) {
    const kind = search[1];
    const query = normalize(url.searchParams.get('query') ?? '');
    const year = url.searchParams.get(kind === 'movie' ? 'year' : 'first_air_date_year');
    const results = DEMO_TITLES.filter(
      (title) =>
        title.kind === kind &&
        query.length > 0 &&
        (normalize(title.title).includes(query) ||
          normalize(title.originalTitle).includes(query)) &&
        (!year || title.date.startsWith(year)),
    ).map((title) => summary(title, url.searchParams.get('language') ?? 'fr-FR'));
    send(response, 200, { page: 1, results, total_results: results.length, total_pages: 1 });
    return true;
  }
  // Listes (tendances, populaires…) : tous les titres du genre demandé, sur une page.
  const list =
    /^\/trending\/(movie|tv)\/(?:day|week)$/.exec(route) ??
    /^\/(movie)\/(?:popular|now_playing|top_rated|upcoming)$/.exec(route) ??
    /^\/(tv)\/(?:popular|on_the_air|top_rated|airing_today)$/.exec(route);
  if (list) {
    const results = DEMO_TITLES.filter((title) => title.kind === list[1]).map((title) =>
      summary(title, url.searchParams.get('language') ?? 'fr-FR'),
    );
    send(response, 200, { page: 1, results, total_results: results.length, total_pages: 1 });
    return true;
  }
  const genreList = /^\/genre\/(movie|tv)\/list$/.exec(route);
  if (genreList) {
    const names = new Set(
      DEMO_TITLES.filter((title) => title.kind === genreList[1]).flatMap((title) => title.genres),
    );
    send(response, 200, {
      genres: [...names].map((name) => ({ id: GENRE_IDS.get(name) ?? 0, name })),
    });
    return true;
  }
  const seasonMatch = /^\/tv\/(\d+)\/season\/(\d+)$/.exec(route);
  if (seasonMatch) {
    const title = DEMO_TITLES.find((item) => item.id === Number(seasonMatch[1]));
    const body = title ? season(title, Number(seasonMatch[2])) : null;
    if (body) send(response, 200, body);
    else send(response, 404, { status_code: 34, status_message: 'Not found' });
    return true;
  }
  const externalIds = /^\/(movie|tv)\/(\d+)\/external_ids$/.exec(route);
  if (externalIds) {
    const title = DEMO_TITLES.find(
      (item) => item.id === Number(externalIds[2]) && item.kind === externalIds[1],
    );
    if (title) send(response, 200, { id: title.id, imdb_id: title.imdb });
    else send(response, 404, { status_code: 34, status_message: 'Not found' });
    return true;
  }
  const detail = /^\/(movie|tv)\/(\d+)$/.exec(route);
  if (detail) {
    const title = DEMO_TITLES.find(
      (item) => item.id === Number(detail[2]) && item.kind === detail[1],
    );
    if (title) send(response, 200, details(title, url.searchParams.get('language') ?? 'fr-FR'));
    else send(response, 404, { status_code: 34, status_message: 'Not found' });
    return true;
  }
  send(response, 404, { status_code: 34, status_message: 'Not found' });
  return true;
}
