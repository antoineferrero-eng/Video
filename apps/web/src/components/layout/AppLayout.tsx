import { FolderTree, Search, Settings } from 'lucide-react';
import { useEffect } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useDownloads } from '../../api/queries';
import { cn } from '../../lib/cn';
import { formatSpeed } from '../../lib/format';
import { Logo } from './Logo';
import { NAV_ITEMS } from './navigation';

export function AppLayout({ connected }: { connected: boolean }) {
  const location = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  return (
    <div className="min-h-dvh lg:pl-64">
      <Sidebar connected={connected} />
      <TopBar />
      <main className="mx-auto w-full max-w-[1800px] px-4 pt-4 pb-28 sm:px-8 lg:pb-12">
        <Outlet />
      </main>
      <MobileNav />
    </div>
  );
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
  const activity = useDownloadActivity();
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-white/5 bg-ink-950/80 px-4 py-6 backdrop-blur-xl lg:flex">
      <Link to="/" className="px-2">
        <Logo />
      </Link>
      <nav className="mt-8 flex flex-1 flex-col gap-1">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition',
                isActive
                  ? 'bg-gradient-to-r from-brand-400/15 to-transparent text-white ring-1 ring-inset ring-brand-400/20'
                  : 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-100',
              )
            }
          >
            {({ isActive }) => (
              <>
                <item.icon
                  className={cn(
                    'size-[18px]',
                    isActive ? 'text-brand-300' : 'text-zinc-500 group-hover:text-zinc-300',
                  )}
                />
                <span className="flex-1">{item.label}</span>
                {item.to === '/telechargements' && activity.pending > 0 && (
                  <span className="rounded-full bg-brand-400 px-2 py-0.5 text-[11px] font-bold text-ink-950">
                    {activity.pending}
                  </span>
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>
      {activity.active > 0 && (
        <Link
          to="/telechargements"
          className="mb-3 rounded-xl border border-brand-400/20 bg-brand-400/[0.06] px-3 py-2.5 text-xs text-brand-200 transition hover:bg-brand-400/10"
        >
          <span className="font-semibold">{activity.active} téléchargement(s) en cours</span>
          <span className="mt-0.5 block text-brand-200/70">{formatSpeed(activity.speed)}</span>
        </Link>
      )}
      <div className="flex items-center gap-2 px-3 text-xs text-zinc-500">
        <span className={cn('size-2 rounded-full', connected ? 'bg-emerald-400' : 'bg-zinc-600')} />
        {connected ? 'Connecté au serveur' : 'Connexion au serveur…'}
      </div>
    </aside>
  );
}

function TopBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const onSearchPage = location.pathname === '/recherche';
  // L'URL est l'unique source de vérité : la saisie navigue vers /recherche?q=…
  const query = onSearchPage ? (params.get('q') ?? '') : '';

  const update = (value: string) => {
    if (value) navigate(`/recherche?q=${encodeURIComponent(value)}`, { replace: onSearchPage });
    else if (onSearchPage) navigate('/', { replace: true });
  };

  return (
    <header className="sticky top-0 z-20 border-b border-white/5 bg-ink-950/75 backdrop-blur-xl">
      <div className="mx-auto flex h-16 w-full max-w-[1800px] items-center gap-3 px-4 sm:px-8">
        <Link to="/" className="lg:hidden">
          <Logo className="[&_span]:hidden sm:[&_span]:inline" />
        </Link>
        <div className="relative max-w-xl flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-zinc-500" />
          <input
            type="search"
            value={query}
            onChange={(event) => update(event.target.value)}
            placeholder="Rechercher un film, une série…"
            className="h-10 w-full rounded-xl border border-white/10 bg-white/[0.04] pr-4 pl-10 text-sm text-zinc-100 placeholder:text-zinc-500 transition outline-none focus:border-brand-400/50 focus:bg-white/[0.06] focus:ring-2 focus:ring-brand-400/15"
          />
        </div>
        <div className="ml-auto flex items-center gap-1 lg:hidden">
          <Link
            to="/explorateur"
            className="rounded-xl p-2.5 text-zinc-400 hover:bg-white/5 hover:text-white"
            aria-label="Explorateur"
          >
            <FolderTree className="size-5" />
          </Link>
          <Link
            to="/parametres"
            className="rounded-xl p-2.5 text-zinc-400 hover:bg-white/5 hover:text-white"
            aria-label="Paramètres"
          >
            <Settings className="size-5" />
          </Link>
        </div>
      </div>
    </header>
  );
}

function MobileNav() {
  const activity = useDownloadActivity();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-white/5 bg-ink-950/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden">
      <div className="grid grid-cols-5">
        {NAV_ITEMS.filter((item) => item.mobile).map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                'relative flex flex-col items-center gap-1 py-2.5 text-[10px] font-medium transition',
                isActive ? 'text-brand-300' : 'text-zinc-500',
              )
            }
          >
            <item.icon className="size-5" />
            {item.shortLabel}
            {item.to === '/telechargements' && activity.pending > 0 && (
              <span className="absolute top-1.5 left-1/2 ml-2 rounded-full bg-brand-400 px-1.5 text-[10px] font-bold text-ink-950">
                {activity.pending}
              </span>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
