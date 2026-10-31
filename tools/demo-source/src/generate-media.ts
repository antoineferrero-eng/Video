/**
 * Génère une arborescence de démonstration (films et séries) avec de vraies vidéos
 * produites par ffmpeg, dans des formats variés pour exercer tous les modes de lecture :
 * MP4 H.264/AAC (lecture directe), MKV multi-pistes + sous-titres (remultiplexage),
 * HEVC 10 bits HDR + E-AC3 5.1 (transcodage), WebM VP9/Opus, séries avec saisons.
 *
 *   npm run demo:media            (depuis la racine du dépôt)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_TITLES, backdropFile, posterFile, stillFile } from './fake-tmdb';

const ROOT = path.resolve(fileURLToPath(new URL('../content', import.meta.url)));
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const force = process.argv.includes('--force');

let drawtextAvailable = true;

function ffmpeg(args: string[]): void {
  const result = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: 'inherit',
  });
  if (result.error) throw new Error(`ffmpeg introuvable (${FFMPEG}) : ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ffmpeg a échoué (code ${result.status})`);
}

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '\u2019')
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%');
}

/** Source vidéo lavfi avec le titre et l'horodatage incrustés (si drawtext est disponible). */
function videoSource(pattern: string, size: string, title: string): string {
  const base = `${pattern}=size=${size}:rate=24`;
  if (!drawtextAvailable) return base;
  const label = escapeDrawtext(title);
  return (
    `${base},drawtext=text='${label}':fontsize=h/12:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=18:` +
    `x=(w-text_w)/2:y=h*0.32,drawtext=text='%{pts\\:hms}':fontsize=h/16:fontcolor=white:box=1:` +
    `boxcolor=black@0.55:boxborderw=12:x=(w-text_w)/2:y=h*0.62`
  );
}

function srt(cues: Array<[string, string, string]>): string {
  return cues
    .map(([start, end, text], index) => `${index + 1}\n${start} --> ${end}\n${text}\n`)
    .join('\n');
}

const FRENCH_CUES = srt([
  ['00:00:01,000', '00:00:04,500', 'Bienvenue dans la démonstration de Lumière.'],
  [
    '00:00:05,000',
    '00:00:09,000',
    "Les sous-titres s'affichent par-dessus la vidéo,\navec les accents : é, è, à, ç, ù.",
  ],
  ['00:00:10,000', '00:00:14,000', '<i>Ce texte est en italique.</i>'],
  ['00:00:20,000', '00:00:25,000', 'Vous pouvez avancer, reculer et reprendre plus tard.'],
  ['00:00:40,000', '00:00:45,000', 'Fin de la démonstration.'],
]);

const ENGLISH_CUES = srt([
  ['00:00:01,000', '00:00:04,500', 'Welcome to the Lumière demo.'],
  ['00:00:20,000', '00:00:25,000', 'Subtitles work in every playback mode.'],
]);

interface Job {
  file: string;
  build: (output: string) => void;
}

function target(...segments: string[]): string {
  return path.join(ROOT, ...segments);
}

function h264Mp4(
  output: string,
  title: string,
  pattern: string,
  size: string,
  seconds: number,
  tone = 440,
): void {
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    videoSource(pattern, size, title),
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${tone}:sample_rate=48000`,
    '-t',
    String(seconds),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '30',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-movflags',
    '+faststart',
    output,
  ]);
}

function h264Mkv(
  output: string,
  title: string,
  pattern: string,
  seconds: number,
  tone: number,
): void {
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    videoSource(pattern, '1280x720', title),
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${tone}:sample_rate=48000`,
    '-t',
    String(seconds),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '30',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    output,
  ]);
}

const jobs: Job[] = [
  {
    file: target(
      'movies',
      'Big Buck Moon (2024)',
      'Big.Buck.Moon.2024.1080p.WEB-DL.H264.AAC-LUMIERE.mp4',
    ),
    build: (output) => h264Mp4(output, 'Big Buck Moon', 'testsrc2', '1280x720', 60),
  },
  {
    file: target(
      'movies',
      'Le Voyage Imaginaire (2023)',
      'Le.Voyage.Imaginaire.2023.MULTi.1080p.WEB.H264.AC3-LUMIERE.mkv',
    ),
    build: (output) => {
      const subtitles = path.join(path.dirname(output), 'embedded.fr.srt.tmp');
      fs.writeFileSync(subtitles, FRENCH_CUES, 'utf8');
      ffmpeg([
        '-f',
        'lavfi',
        '-i',
        videoSource('smptehdbars', '1280x720', 'Le Voyage Imaginaire'),
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=330:sample_rate=48000',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=660:sample_rate=48000',
        '-f',
        'srt',
        '-i',
        subtitles,
        '-t',
        '60',
        '-map',
        '0:v',
        '-map',
        '1:a',
        '-map',
        '2:a',
        '-map',
        '3:s',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '30',
        '-pix_fmt',
        'yuv420p',
        '-c:a:0',
        'ac3',
        '-b:a:0',
        '192k',
        '-c:a:1',
        'aac',
        '-b:a:1',
        '128k',
        '-c:s',
        'srt',
        '-metadata:s:a:0',
        'language=eng',
        '-metadata:s:a:0',
        'title=English',
        '-metadata:s:a:1',
        'language=fre',
        '-metadata:s:a:1',
        'title=Français',
        '-metadata:s:s:0',
        'language=fre',
        '-disposition:a:0',
        'default',
        '-disposition:a:1',
        '0',
        output,
      ]);
      fs.rmSync(subtitles, { force: true });
      fs.writeFileSync(
        path.join(path.dirname(output), 'Le.Voyage.Imaginaire.2023.en.srt'),
        ENGLISH_CUES,
        'utf8',
      );
    },
  },
  {
    file: target(
      'movies',
      'COSMOS ODYSSEY (2025)',
      'Cosmos.Odyssey.2025.2160p.WEB-DL.HDR.HEVC.10bit.DDP5.1-LUMIERE.mkv',
    ),
    build: (output) =>
      ffmpeg([
        '-f',
        'lavfi',
        '-i',
        videoSource('mandelbrot', '960x540', 'Cosmos Odyssey (HEVC 10 bits HDR)'),
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=520:sample_rate=48000',
        '-t',
        '40',
        '-c:v',
        'libx265',
        '-preset',
        'ultrafast',
        '-crf',
        '30',
        '-pix_fmt',
        'yuv420p10le',
        '-x265-params',
        'log-level=error',
        '-color_primaries',
        'bt2020',
        '-color_trc',
        'smpte2084',
        '-colorspace',
        'bt2020nc',
        '-c:a',
        'eac3',
        '-ac',
        '6',
        '-b:a',
        '384k',
        output,
      ]),
  },
  {
    file: target(
      'movies',
      'Nuit Blanche (2022)',
      'Nuit.Blanche.2022.720p.WEBRip.VP9.Opus-LUMIERE.webm',
    ),
    build: (output) =>
      ffmpeg([
        '-f',
        'lavfi',
        '-i',
        videoSource('rgbtestsrc', '1280x720', 'Nuit Blanche (WebM VP9)'),
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=880:sample_rate=48000',
        '-t',
        '45',
        '-c:v',
        'libvpx-vp9',
        // Sans quoi ffmpeg 9 choisit un format RGB (gbrap) que l'encodeur VP9 refuse.
        '-pix_fmt',
        'yuv420p',
        '-deadline',
        'realtime',
        '-cpu-used',
        '8',
        '-b:v',
        '0',
        '-crf',
        '45',
        '-c:a',
        'libopus',
        '-b:a',
        '96k',
        output,
      ]),
  },
  {
    file: target(
      'movies',
      'Le Dernier Train (2021)',
      'Le.Dernier.Train.2021.1080p.BluRay.x264.TRUEFRENCH-LUMIERE.mp4',
    ),
    build: (output) => h264Mp4(output, 'Le Dernier Train (1080p)', 'testsrc', '1920x1080', 30, 300),
  },
  {
    file: target(
      'movies',
      'Le Dernier Train (2021)',
      'Le.Dernier.Train.2021.720p.WEB.x264.VOSTFR-LUMIERE.mp4',
    ),
    build: (output) => h264Mp4(output, 'Le Dernier Train (720p)', 'testsrc', '1280x720', 30, 300),
  },
  ...[1, 2, 3].map((episode) => {
    const file = target(
      'tvs',
      'Les Explorateurs',
      'Season 1',
      `Les.Explorateurs.S01E0${episode}.1080p.WEB.H264-LUMIERE.mkv`,
    );
    return {
      file,
      build: (output: string) => {
        h264Mkv(output, `Les Explorateurs S01E0${episode}`, 'testsrc2', 30, 400 + episode * 40);
        if (episode === 1) {
          // Sous-titres en Windows-1252, comme beaucoup de fichiers .srt français.
          fs.writeFileSync(file.replace(/\.mkv$/, '.fr.srt'), Buffer.from(FRENCH_CUES, 'latin1'));
        }
      },
    };
  }),
  {
    file: target(
      'tvs',
      'Les Explorateurs',
      'Season 2',
      'Les.Explorateurs.S02E01.1080p.WEB.H264-LUMIERE.mkv',
    ),
    build: (output) => h264Mkv(output, 'Les Explorateurs S02E01', 'smptebars', 30, 600),
  },
  ...[1, 2].map((episode) => ({
    file: target('tvs', 'Orbite (2020)', `Orbite.S01E0${episode}.720p.HDTV.x264-LUMIERE.mp4`),
    build: (output: string) =>
      h264Mp4(output, `Orbite S01E0${episode}`, 'rgbtestsrc', '1280x720', 30, 700 + episode * 30),
  })),
];

/** Découpe un titre en lignes courtes pour l'affiche. */
function wrapTitle(title: string, max = 12): string[] {
  const lines: string[] = [];
  for (const word of title.toUpperCase().split(/\s+/)) {
    const last = lines.at(-1);
    if (last && `${last} ${word}`.length <= max) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines;
}

function text(value: string, size: number, y: number | string, alpha = 1): string {
  if (!drawtextAvailable) return '';
  return (
    `,drawtext=text='${escapeDrawtext(value)}':fontsize=${size}:fontcolor=white@${alpha}:` +
    `x=(w-text_w)/2:y=${y}:shadowcolor=black@0.5:shadowx=2:shadowy=2`
  );
}

/** Affiches, fonds et vignettes servis par le faux service TMDB de la démonstration. */
function generateArtwork(): number {
  const dir = path.join(ROOT, '.tmdb');
  fs.mkdirSync(dir, { recursive: true });
  let created = 0;
  const image = (file: string, filter: string) => {
    const output = path.join(dir, file);
    if (!force && fs.existsSync(output)) return;
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      `${filter},format=yuvj420p`,
      '-frames:v',
      '1',
      '-q:v',
      '4',
      output,
    ]);
    created += 1;
  };
  for (const title of DEMO_TITLES) {
    const [c0, c1] = title.colors;
    const lines = wrapTitle(title.title);
    const top = 470 - lines.length * 58;
    const bottom = top + lines.length * 58;
    const titleText = lines.map((line, index) => text(line, 54, top + index * 58)).join('');
    image(
      posterFile(title),
      `gradients=s=500x750:c0=${c0}:c1=${c1}:c2=0x0b0b12:nb_colors=3:x0=40:y0=0:x1=460:y1=750:d=1:speed=0.0001,` +
        `vignette=PI/5${titleText}` +
        (drawtextAvailable
          ? `,drawbox=x=60:y=${bottom + 14}:w=380:h=2:color=white@0.5:t=fill`
          : '') +
        text(title.date.slice(0, 4), 24, bottom + 34, 0.8),
    );
    image(
      backdropFile(title),
      `gradients=s=1280x720:c0=${c1}:c1=${c0}:c2=0x050508:nb_colors=3:type=radial:x0=980:y0=260:x1=1280:y1=900:d=1:speed=0.0001,vignette=PI/4`,
    );
    for (const [season, episodes] of Object.entries(title.seasons ?? {})) {
      episodes.forEach((episode, index) => {
        image(
          stillFile(title, Number(season), index + 1),
          `gradients=s=400x225:c0=${c1}:c1=${c0}:nb_colors=2:x0=0:y0=0:x1=400:y1=225:d=1:speed=0.0001,vignette=PI/4` +
            text(episode.name, 22, '(h-text_h)/2'),
        );
      });
    }
  }
  return created;
}

function checkDrawtext(): void {
  const probe = spawnSync(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      "color=size=64x64:duration=0.1,drawtext=text='x'",
      '-f',
      'null',
      '-',
    ],
    {
      stdio: 'ignore',
    },
  );
  drawtextAvailable = probe.status === 0;
  if (!drawtextAvailable)
    console.log('ℹ️  drawtext indisponible : les vidéos seront générées sans texte incrusté.');
}

function main(): void {
  checkDrawtext();
  let created = 0;
  for (const job of jobs) {
    if (!force && fs.existsSync(job.file)) continue;
    fs.mkdirSync(path.dirname(job.file), { recursive: true });
    const temp = `${job.file}.tmp${path.extname(job.file)}`;
    process.stdout.write(`• ${path.relative(ROOT, job.file)} … `);
    job.build(temp);
    fs.renameSync(temp, job.file);
    created += 1;
    console.log('ok');
  }
  created += generateArtwork();
  fs.writeFileSync(
    path.join(ROOT, 'LISEZMOI.txt'),
    'Contenu de démonstration généré pour Lumière.\n',
  );
  console.log(
    created > 0
      ? `\n${created} fichier(s) généré(s) dans ${ROOT}`
      : `Contenu déjà présent dans ${ROOT} (--force pour régénérer).`,
  );
}

main();
