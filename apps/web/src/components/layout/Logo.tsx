import { cn } from '../../lib/cn';

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn('size-9', className)} aria-hidden="true">
      <defs>
        <linearGradient id="lumiere-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fde68a" />
          <stop offset="0.55" stopColor="#fbbf24" />
          <stop offset="1" stopColor="#d97706" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="#14141d" />
      <path d="M14 18 L50 32 L14 46 Z" fill="url(#lumiere-logo)" opacity="0.18" />
      <path d="M24 21.5 L45 32 L24 42.5 Z" fill="url(#lumiere-logo)" />
      <circle cx="17" cy="32" r="5" fill="url(#lumiere-logo)" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <LogoMark />
      <span className="bg-gradient-to-r from-white to-zinc-400 bg-clip-text text-xl font-bold tracking-tight text-transparent">
        Lumière
      </span>
    </div>
  );
}
