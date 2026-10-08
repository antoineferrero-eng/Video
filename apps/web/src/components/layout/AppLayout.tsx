import { ArrowDownToLine, ChevronLeft, Search, Settings } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useDownloads } from '../../api/queries';
import { AmbientBackground } from '../../design/ambient/AmbientBackground';
import { Glass } from '../../design/glass/Glass';
import { useLiquidIndicator } from '../../design/glass/useLiquidIndicator';
import { cn } from '../../lib/cn';
import { formatSpeed } from '../../lib/format';
import { Button, ButtonLink } from '../ui/Button';
import { Logo, LogoMark } from './Logo';
import { activeNavKey, NAV_ITEMS } from './navigation';

/**
 * Mise en page Liquid Glass : le contenu occupe toute la fenêtre et la couche fonctionnelle
 * flotte au-dessus — barre latérale incrustée (grand écran), barre d'outils, barre d'onglets
 * (mobile) — avec un effet de bord de défilement à la place des séparateurs.
 */
export function AppLayout({ connected }: { connected: boolean }) {
  const location = useLocation();
  const { scrolled, minimized, expand } = useScrollState();

  useEffect(() => {
    // Un lien vers une ancre (« #tmdb ») amène lui-même la rubrique à l'écran.
    if (!window.location.hash) window.scrollTo({ top: 0 });
  }, [location.pathname]);

  return (
    <div className="app-frame min-h-dvh">
      <AmbientBackground />
      <div className="scroll-edge scroll-edge-top z-20" data-active={scrolled} />
      <main className="app-main">
        <Outlet />
      </main>
      <div className="scroll-edge scroll-edge-bottom z-20 lg:hidden" data-active="true" />
      <Sidebar connected={connected} />
      <Toolbar />
      <TabBar minimized={minimized} onExpand={expand} />
    </div>
  );
}

/** Défilement : bord de défilement actif, barre d'onglets réduite en descendant (iOS 26). */
function useScrollState() {
  const [state, setState] = useState({ scrolled: false, minimized: false });
  useEffect(() => {
    let last = window.scrollY;
    let frame = 0;
    const update = () => {
      frame = 0;
      const y = window.scrollY;
      const delta = y - last;
      last = y;
      setState((previous) => {
        const scrolled = y > 4;
        let minimized = previous.minimized;
        if (y < 96) minimized = false;
        else if (delta > 4) minimized = true;
        else if (delta < -4) minimized = false;
        return previous.scrolled === scrolled && previous.minimized === minimized
          ? previous
          : { scrolled, minimized };
      });
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);
  return {
    ...state,
    expand: () => setState((previous) => ({ ...previous, minimized: false })),
  };
}

function useDownloadActivity() {
  const { data } = useDownloads();
  return {
    active: data?.stats.active ?? 0,
    pending: (data?.stats.active ?? 0) + (data?.stats.queued ?? 0),
    speed: data?.stats.speed ?? 0,
  };
}

function Sidebar({ connected }: { connected: boolean }) {
  const location = useLocation();
  const activity = useDownloadActivity();
  const { container: nav, indicator } = useLiquidIndicator<HTMLElement>(
    activeNavKey(location.pathname),
    'y',
  );

  return (
    <Glass
      as="aside"
      lens={{ bezel: 22, strength: 20 }}
      className="fixed top-3 bottom-3 left-3 z-30 hidden w-[var(--sidebar-width)] flex-col rounded-panel px-3 pt-5 pb-4 lg:flex"
    >
      <Link to="/" className="rounded-[1.125rem] px-2.5 py-1" aria-label="Lumière — accueil">
        <Logo />
      </Link>
      <nav
        ref={nav}
        aria-label="Navigation principale"
        className="relative mt-7 flex flex-col gap-1"
      >
        <span
          ref={indicator}
          aria-hidden="true"
          className="lens-indicator rounded-tile opacity-0"
        />
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            data-indicator-key={item.to}
            className={({ isActive }) =>
              cn(
                'group relative z-[1] flex items-center gap-3 rounded-tile px-3 py-2.5 text-[15px] font-medium transition-colors duration-200',
                isActive ? 'text-white' : 'text-zinc-300 hover:bg-white/[0.06] hover:text-white',
              )
            }
          >
            {({ isActive }) => (
              <>
                <item.icon
                  className={cn(
                    'size-[19px] transition-colors',
                    isActive ? 'text-brand-300' : 'text-zinc-400 group-hover:text-zinc-200',
                  )}
                />
                <span className="flex-1">{item.label}</span>
                {item.to === '/telechargements' && activity.pending > 0 && (
                  <span className="min-w-5 rounded-full bg-brand-400 px-1.5 text-center text-[11px] leading-5 font-bold text-ink-950 tabular-nums">
                    {activity.pending}
                  </span>
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-3">
        {activity.active > 0 && (
          <Link
            to="/telechargements"
            className="fill-strong rounded-tile px-3.5 py-3 text-xs transition hover:bg-white/[0.16]"
          >
            <span className="flex items-center gap-2 font-semibold text-white">
              <ArrowDownToLine className="size-3.5 text-brand-300" />
              {activity.active} téléchargement{activity.active > 1 ? 's' : ''} en cours
            </span>
            <span className="mt-0.5 block pl-5.5 text-zinc-300">{formatSpeed(activity.speed)}</span>
          </Link>
        )}
        <div className="flex items-center gap-2 px-3 text-xs text-zinc-400">
          <span
            className={cn(
              'size-2 rounded-full',
              connected ? 'bg-emerald-400 shadow-[0_0_8px_rgb(52_211_153/0.8)]' : 'bg-zinc-600',
            )}
          />
          {connected ? 'Connecté au serveur' : 'Connexion au serveur…'}
        </div>
      </div>
    </Glass>
  );
}

function Toolbar() {
  const location = useLocation();
  const navigate = useNavigate();
  const activity = useDownloadActivity();
  const rootPage = activeNavKey(location.pathname) !== null;
  const goBack = () => {
    const index = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (index > 0) navigate(-1);
    else navigate('/');
  };

  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-30 flex h-[4.5rem] items-center gap-2 pr-[var(--inset-right)] pl-[var(--toolbar-left)] lg:h-[5rem]">
      <div className="pointer-events-auto flex items-center gap-2">
        {rootPage ? (
          <Link to="/" aria-label="Lumière — accueil" className="rounded-[0.9rem] lg:hidden">
            <LogoMark className="size-10" />
          </Link>
        ) : (
          <Button variant="glass" size="icon" aria-label="Retour" onClick={goBack}>
            <ChevronLeft className="size-5" />
          </Button>
        )}
      </div>
      <div className="flex-1" />
      <div className="pointer-events-auto flex items-center gap-2">
        {activity.active > 0 && (
          <div className="hidden lg:block">
            <ButtonLink
              to="/telechargements"
              variant="glass"
              className="px-4"
              icon={<ArrowDownToLine className="size-4 text-brand-300" />}
              title="Téléchargements en cours"
            >
              <span className="tabular-nums">
                {activity.active} · {formatSpeed(activity.speed)}
              </span>
            </ButtonLink>
          </div>
        )}
        <SearchField />
        <Glass className="flex items-center gap-0.5 rounded-full p-1 lg:hidden">
          <ToolbarIcon to="/parametres" label="Paramètres">
            <Settings className="size-[18px]" />
          </ToolbarIcon>
        </Glass>
      </div>
    </header>
  );
}

function ToolbarIcon({ to, label, children }: { to: string; label: string; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      aria-label={label}
      title={label}
      className={({ isActive }) =>
        cn(
          'flex size-9 items-center justify-center rounded-full transition-colors',
          isActive ? 'bg-white/[0.14] text-brand-300' : 'text-zinc-200 hover:bg-white/10',
        )
      }
    >
      {children}
    </NavLink>
  );
}

/** Champ de recherche en verre (grand écran) ; « / » ou Ctrl+K pour y accéder. */
function SearchField() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const input = useRef<HTMLInputElement>(null);
  const onSearchPage = location.pathname === '/recherche';
  // La saisie navigue vers /recherche?q=… ; un brouillon local évite de perdre des lettres
  // pendant le chargement de la page de résultats, et suit l'URL quand elle change ailleurs.
  const urlQuery = onSearchPage ? (params.get('q') ?? '') : '';
  const [query, setQuery] = useState(urlQuery);
  const [syncedQuery, setSyncedQuery] = useState(urlQuery);
  if (urlQuery !== syncedQuery) {
    setSyncedQuery(urlQuery);
    setQuery(urlQuery);
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing =
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement;
      const shortcut =
        (event.key === '/' && !typing) || (event.key === 'k' && (event.ctrlKey || event.metaKey));
      if (!shortcut || !input.current?.offsetParent) return;
      event.preventDefault();
      input.current.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const update = (value: string) => {
    setQuery(value);
    if (value) navigate(`/recherche?q=${encodeURIComponent(value)}`, { replace: onSearchPage });
    else if (onSearchPage) navigate('/', { replace: true });
  };

  return (
    <Glass className="glass-field hidden h-11 w-[clamp(15rem,26vw,24rem)] items-center gap-2.5 rounded-full pr-3 pl-4 lg:flex">
      <Search className="size-4 shrink-0 text-zinc-300" aria-hidden="true" />
      <input
        ref={input}
        type="search"
        value={query}
        onChange={(event) => update(event.target.value)}
        placeholder="Rechercher un film, une série…"
        aria-label="Rechercher un film ou une série"
        className="h-full min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-zinc-400"
      />
      {!query && (
        <kbd className="rounded-md bg-white/10 px-1.5 py-0.5 font-sans text-[11px] text-zinc-300">
          /
        </kbd>
      )}
    </Glass>
  );
}

/** Barre d'onglets flottante (mobile) : se réduit à l'onglet actif quand on fait défiler. */
function TabBar({ minimized, onExpand }: { minimized: boolean; onExpand: () => void }) {
  const location = useLocation();
  const activity = useDownloadActivity();
  const items = NAV_ITEMS.filter((item) => item.mobile);
  const activeKey = activeNavKey(location.pathname, items);
  const { container, indicator } = useLiquidIndicator(activeKey);
  const searchActive = location.pathname === '/recherche';
  const collapsed = minimized && activeKey !== null;

  return (
    <div className="pointer-events-none fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] z-30 flex items-center justify-between gap-3 lg:hidden">
      <Glass
        as="nav"
        aria-label="Navigation principale"
        lens={{ bezel: 18, strength: 16 }}
        onPointerDownCapture={collapsed ? onExpand : undefined}
        className="pointer-events-auto h-16 rounded-full p-1.5 transition-[width] duration-500 ease-spring"
        style={{ width: collapsed ? '4rem' : 'calc(100% - 4.75rem)' }}
      >
        <div ref={container} className="relative flex h-full items-stretch">
          <span
            ref={indicator}
            aria-hidden="true"
            className="lens-indicator rounded-full opacity-0"
          />
          {items.map((item) => {
            const active = item.to === activeKey;
            const hidden = collapsed && !active;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                data-indicator-key={item.to}
                aria-hidden={hidden || undefined}
                tabIndex={hidden ? -1 : undefined}
                className={cn(
                  'relative z-[1] flex min-w-0 flex-col items-center justify-center gap-0.5 overflow-hidden rounded-full text-[10px] font-semibold whitespace-nowrap transition-all duration-500 ease-spring',
                  hidden ? 'w-0 flex-none px-0 opacity-0' : 'flex-1 px-1 opacity-100',
                  active ? 'text-brand-300' : 'text-zinc-200',
                )}
              >
                <item.icon className="size-[22px] shrink-0" />
                {!collapsed && <span className="max-w-full truncate">{item.shortLabel}</span>}
                {item.to === '/telechargements' && activity.pending > 0 && (
                  <span className="absolute top-1 left-1/2 ml-1.5 min-w-4 rounded-full bg-brand-400 px-1 text-center text-[10px] leading-4 font-bold text-ink-950">
                    {activity.pending}
                  </span>
                )}
              </NavLink>
            );
          })}
        </div>
      </Glass>
      <nav aria-label="Recherche" className="pointer-events-auto">
        <ButtonLink
          to="/recherche"
          variant="glass"
          size="icon-xl"
          aria-label="Rechercher"
          aria-current={searchActive ? 'page' : undefined}
          className={cn(searchActive && 'text-brand-300')}
        >
          <Search className="size-6" />
        </ButtonLink>
      </nav>
    </div>
  );
}
