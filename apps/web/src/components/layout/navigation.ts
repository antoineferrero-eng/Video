import { Download, Film, Home, Library, Settings, Tv, type LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  shortLabel: string;
  icon: LucideIcon;
  end?: boolean;
  mobile?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Accueil', shortLabel: 'Accueil', icon: Home, end: true, mobile: true },
  { to: '/films', label: 'Films', shortLabel: 'Films', icon: Film, mobile: true },
  { to: '/series', label: 'Séries', shortLabel: 'Séries', icon: Tv, mobile: true },
  {
    to: '/bibliotheque',
    label: 'Ma bibliothèque',
    shortLabel: 'Biblio.',
    icon: Library,
    mobile: true,
  },
  {
    to: '/telechargements',
    label: 'Téléchargements',
    shortLabel: 'Téléch.',
    icon: Download,
    mobile: true,
  },
  { to: '/parametres', label: 'Paramètres', shortLabel: 'Réglages', icon: Settings },
];

/** Entrée de navigation correspondant à l'URL (null pour une page de détail). */
export function activeNavKey(pathname: string, items: NavItem[] = NAV_ITEMS): string | null {
  const match = items.find((item) =>
    item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`),
  );
  return match?.to ?? null;
}
