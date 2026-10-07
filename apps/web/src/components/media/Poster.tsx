import { Clapperboard, Tv } from 'lucide-react';
import { useState } from 'react';
import { gradientFor } from '../../lib/artwork';
import { cn } from '../../lib/cn';

/** Affiche (image TMDB) avec repli sur un visuel généré à partir du titre. */
export function Poster({
  url,
  title,
  year,
  kind = 'movie',
  className,
  eager = false,
}: {
  url: string | null;
  title: string;
  year?: number | null;
  kind?: 'movie' | 'series';
  className?: string;
  eager?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const showImage = url && !failed;

  return (
    <div className={cn('relative aspect-[2/3] overflow-hidden bg-ink-800', className)}>
      {(!showImage || !loaded) && <GeneratedPoster title={title} year={year} kind={kind} />}
      {showImage && (
        <img
          src={url}
          alt={title}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={cn(
            'absolute inset-0 size-full object-cover transition-opacity duration-500',
            loaded ? 'opacity-100' : 'opacity-0',
          )}
        />
      )}
    </div>
  );
}

function GeneratedPoster({ title, year, kind }: { title: string; year?: number | null; kind: 'movie' | 'series' }) {
  const Icon = kind === 'series' ? Tv : Clapperboard;
  return (
    <div className="absolute inset-0 flex flex-col justify-between p-4" style={{ background: gradientFor(title) }}>
      <Icon className="size-5 text-white/40" />
      <div>
        <p className="line-clamp-4 text-lg leading-tight font-bold text-balance text-white drop-shadow-sm">{title}</p>
        {year && <p className="mt-1 text-sm font-medium text-white/60">{year}</p>}
      </div>
    </div>
  );
}

/** Image de fond (paysage) avec repli dégradé. */
export function Backdrop({ url, seed, className }: { url: string | null; seed: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={cn('absolute inset-0 overflow-hidden', className)}>
      <div className="absolute inset-0" style={{ background: gradientFor(seed) }} />
      {url && !failed && (
        <img
          src={url}
          alt=""
          className="absolute inset-0 size-full animate-fade-in object-cover"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
