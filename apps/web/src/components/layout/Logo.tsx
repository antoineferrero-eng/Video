import { useId } from 'react';
import { cn } from '../../lib/cn';

/** Icône d'application en couches de verre : fond fumé, faisceau ambré, reflet spéculaire. */
export function LogoMark({ className }: { className?: string }) {
  // Identifiants uniques : plusieurs logos coexistent (barre latérale + barre d'outils mobile).
  const id = useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 64 64" className={cn('size-9', className)} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2a2a35" />
          <stop offset="1" stopColor="#0c0c12" />
        </linearGradient>
        <linearGradient id={`${id}-beam`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fef3c7" />
          <stop offset="0.5" stopColor="#fbbf24" />
          <stop offset="1" stopColor="#d97706" />
        </linearGradient>
        <linearGradient id={`${id}-shine`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.32" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}-rim`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="0.45" stopColor="#fff" stopOpacity="0.06" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.3" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="18" fill={`url(#${id}-tile)`} />
      <path d="M13 17 L52 32 L13 47 Z" fill={`url(#${id}-beam)`} opacity="0.16" />
      <path d="M24 20.5 L46 32 L24 43.5 Z" fill={`url(#${id}-beam)`} />
      <circle cx="16.5" cy="32" r="5.5" fill={`url(#${id}-beam)`} />
      <rect width="64" height="32" rx="18" fill={`url(#${id}-shine)`} />
      <rect
        x="0.75"
        y="0.75"
        width="62.5"
        height="62.5"
        rx="17.25"
        fill="none"
        stroke={`url(#${id}-rim)`}
        strokeWidth="1.5"
      />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <LogoMark />
      <span className="text-xl font-bold tracking-tight text-white">Lumière</span>
    </div>
  );
}
