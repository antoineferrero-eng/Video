import { ArrowRight, Check, ExternalLink, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { ButtonLink } from '../../components/ui/Button';
import { Glass } from '../../design/glass/Glass';
import { cn } from '../../lib/cn';
import { setupUrl, type SetupStatus } from './setup-status';

interface Step {
  done: boolean;
  title: string;
  description: string;
  link: { href: string; label: string };
}

/**
 * Carte de bienvenue du premier lancement : ce qu'il manque (clé TMDB, extension Stremio),
 * où l'obtenir, et un bouton qui mène directement aux paramètres.
 */
export function SetupCard({ status, className }: { status: SetupStatus; className?: string }) {
  const steps: Step[] = [
    {
      done: status.tmdb,
      title: 'Clé d’API TMDB',
      description:
        'Gratuite : elle fournit le catalogue des films et séries, les affiches et les résumés.',
      link: { href: 'https://www.themoviedb.org/settings/api', label: 'Obtenir une clé' },
    },
    {
      done: status.addons,
      title: 'Une source de fichiers',
      description:
        'Une extension Stremio (celle de 111477 se configure sur sa page), ou un site comme loadix.fun avec un compte 1fichier premium.',
      link: { href: 'https://st.111477.xyz/', label: 'Configurer 111477' },
    },
  ];
  const remaining = steps.filter((step) => !step.done).length;
  return (
    <Glass
      as="section"
      aria-labelledby="setup-title"
      className={cn('relative overflow-hidden rounded-panel p-5 sm:p-7', className)}
    >
      {/* Halo d'accent derrière le contenu. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 -left-16 size-72 rounded-full bg-brand-400/20 blur-3xl"
      />
      <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:gap-10">
        <div className="flex max-w-md flex-col gap-3">
          <span className="flex size-11 items-center justify-center rounded-full bg-brand-400/15 text-brand-200 ring-1 ring-brand-300/30 ring-inset">
            <Sparkles className="size-5" />
          </span>
          <h2 id="setup-title" className="text-2xl font-bold tracking-tight text-white">
            Bienvenue sur Lumière
          </h2>
          <p className="text-sm leading-relaxed text-zinc-300">
            {remaining > 1
              ? 'Encore deux réglages avant de parcourir le catalogue, de regarder et de télécharger vos films et séries.'
              : 'Plus qu’un réglage avant de parcourir le catalogue, de regarder et de télécharger vos films et séries.'}
          </p>
          <div className="pt-1">
            <ButtonLink
              to={setupUrl(status)}
              variant="primary"
              icon={<ArrowRight className="size-4" />}
            >
              Ouvrir les paramètres
            </ButtonLink>
          </div>
        </div>
        <ol className="flex flex-1 flex-col gap-2.5">
          {steps.map((step, index) => (
            <SetupStep key={step.title} step={step} number={index + 1} />
          ))}
        </ol>
      </div>
    </Glass>
  );
}

function SetupStep({ step, number }: { step: Step; number: number }) {
  return (
    <li
      className={cn(
        'flex items-start gap-3.5 rounded-[1.25rem] p-3.5',
        step.done ? 'bg-white/[0.04]' : 'fill',
      )}
    >
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
          step.done
            ? 'bg-emerald-400/15 text-emerald-200 ring-1 ring-emerald-300/30 ring-inset'
            : 'bg-white/[0.1] text-white ring-1 ring-white/15 ring-inset',
        )}
        aria-hidden
      >
        {step.done ? <Check className="size-4" /> : number}
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn('font-semibold', step.done ? 'text-zinc-400' : 'text-white')}>
          {step.title}
          <span className="sr-only">{step.done ? ' : fait' : ' : à faire'}</span>
        </p>
        {!step.done && (
          <>
            <p className="mt-0.5 text-sm text-zinc-400">{step.description}</p>
            <StepLink href={step.link.href}>{step.link.label}</StepLink>
          </>
        )}
      </div>
    </li>
  );
}

function StepLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-brand-300 hover:text-brand-200"
    >
      {children}
      <ExternalLink aria-hidden className="size-3.5" />
    </a>
  );
}

/** Rappel compact (pages du catalogue) : ce qu'il manque, et un lien vers les paramètres. */
export function SetupBanner({ status, className }: { status: SetupStatus; className?: string }) {
  const missing = [
    !status.tmdb && 'la clé d’API TMDB (catalogue)',
    !status.addons && 'une source de fichiers (extension Stremio ou site)',
  ].filter(Boolean);
  return (
    <Glass
      role="status"
      className={cn(
        'flex flex-col gap-3 rounded-[1.5rem] p-3 pl-4 sm:flex-row sm:items-center',
        className,
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-400/15 text-brand-200 ring-1 ring-brand-300/30 ring-inset">
        <Sparkles className="size-4" />
      </span>
      <p className="flex-1 text-sm text-zinc-200">
        <span className="font-semibold text-white">Configuration à terminer : </span>
        renseignez {missing.join(' et ')}.
      </p>
      <ButtonLink
        to={setupUrl(status)}
        variant="primary"
        size="sm"
        icon={<ArrowRight className="size-4" />}
        className="self-start sm:self-auto"
      >
        Configurer
      </ButtonLink>
    </Glass>
  );
}
