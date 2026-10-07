import { useRef, useState, type PointerEvent } from 'react';
import { formatClock } from '../../lib/format';

/** Barre de progression du lecteur : temps écoulé, mémoire tampon, survol et glisser. */
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

  const shown = drag ?? current;
  const percent = total ? (shown / total) * 100 : 0;
  const bufferedPercent = total ? Math.min(100, (buffered / total) * 100) : 0;

  return (
    <div
      ref={track}
      className="group relative flex h-5 cursor-pointer touch-none items-center"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setHover(null)}
      role="slider"
      aria-label="Position de lecture"
      aria-valuemin={0}
      aria-valuemax={total ?? 0}
      aria-valuenow={Math.round(shown)}
    >
      <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/20 transition-[height] group-hover:h-1.5">
        <div
          className="absolute inset-y-0 left-0 bg-white/30"
          style={{ width: `${bufferedPercent}%` }}
        />
        <div className="absolute inset-y-0 left-0 bg-brand-400" style={{ width: `${percent}%` }} />
      </div>
      <div
        className="absolute size-3.5 -translate-x-1/2 rounded-full bg-brand-300 opacity-0 shadow transition group-hover:opacity-100"
        style={{ left: `${percent}%`, opacity: drag !== null ? 1 : undefined }}
      />
      {hover !== null && total && (
        <div
          className="pointer-events-none absolute -top-8 -translate-x-1/2 rounded-md bg-black/80 px-2 py-0.5 text-xs font-medium tabular-nums"
          style={{ left: `${(hover / total) * 100}%` }}
        >
          {formatClock(hover)}
        </div>
      )}
    </div>
  );
}
