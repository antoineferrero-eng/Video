import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { cn } from '../../lib/cn';
import { formatClock } from '../../lib/format';

/**
 * Barre de progression du lecteur : temps écoulé, mémoire tampon, survol et glisser.
 * Pendant le glisser, le curseur grossit et devient une lentille de verre (iOS 26).
 */
export function ProgressSlider({
  current,
  duration,
  buffered,
  onSeek,
}: {
  current: number;
  duration: number | null;
  buffered: number;
  onSeek: (time: number) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const total = duration && duration > 0 ? duration : null;

  const timeAt = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect || !total) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * total;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!total) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag(timeAt(event.clientX));
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const time = timeAt(event.clientX);
    setHover(time);
    if (drag !== null) setDrag(time);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (drag === null) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onSeek(timeAt(event.clientX));
    setDrag(null);
  };
  // Accessibilité : la barre se pilote aussi au clavier (les flèches globales restent actives).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!total) return;
    if (event.key === 'Home') onSeek(0);
    else if (event.key === 'End') onSeek(total - 1);
    else if (event.key === 'PageUp') onSeek(current + 60);
    else if (event.key === 'PageDown') onSeek(current - 60);
    else return;
    event.preventDefault();
  };

  const shown = drag ?? current;
  const percent = total ? (shown / total) * 100 : 0;
  const bufferedPercent = total ? Math.min(100, (buffered / total) * 100) : 0;
  const preview = drag ?? hover;

  return (
    <div
      ref={track}
      className="group relative flex h-6 cursor-pointer touch-none items-center"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setHover(null)}
      onKeyDown={onKeyDown}
      tabIndex={0}
      role="slider"
      aria-label="Position de lecture"
      aria-valuemin={0}
      aria-valuemax={Math.round(total ?? 0)}
      aria-valuenow={Math.round(shown)}
      aria-valuetext={`${formatClock(shown)} sur ${total ? formatClock(total) : 'durée inconnue'}`}
    >
      <div
        className={cn(
          'relative h-1.5 w-full overflow-hidden rounded-full bg-white/25 shadow-[inset_0_1px_1px_rgb(0_0_0/0.4)] transition-[height] duration-300 ease-spring group-hover:h-2',
          drag !== null && 'h-2.5 group-hover:h-2.5',
        )}
      >
        <div
          className="absolute inset-y-0 left-0 bg-white/30"
          style={{ width: `${bufferedPercent}%` }}
        />
        <div
          className="absolute inset-y-0 left-0 bg-gradient-to-r from-brand-300 to-brand-400"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div
        aria-hidden="true"
        className={cn(
          'absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-[width,height,opacity,background-color] duration-300 ease-spring',
          drag !== null
            ? 'glass glass-clear size-7'
            : 'size-3.5 bg-white opacity-0 shadow-[0_2px_6px_rgb(0_0_0/0.5)] group-hover:opacity-100 group-focus-visible:opacity-100',
        )}
        style={{ left: `${percent}%` }}
      />
      {preview !== null && total && (
        <div
          className="glass glass-thick pointer-events-none absolute -top-10 -translate-x-1/2 rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums"
          style={{ left: `${(preview / total) * 100}%` }}
        >
          {formatClock(preview)}
        </div>
      )}
    </div>
  );
}
