import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Button } from '../ui/Button';

/**
 * Rangée horizontale défilante (accueil). Elle s'étend sur toute la largeur et glisse sous la
 * barre latérale en verre, tout en restant alignée sur le contenu.
 */
export function MediaRow({
  title,
  action,
  children,
}: {
  title: string;
  action?: { label: string; to: string };
  children: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const scroll = (direction: number) => {
    const element = scroller.current;
    if (element)
      element.scrollBy({ left: direction * element.clientWidth * 0.75, behavior: 'smooth' });
  };

  return (
    <section className="relative">
      <div className="mb-3 flex items-end justify-between gap-4">
        <h2 className="text-xl font-bold tracking-tight text-white sm:text-[1.375rem]">{title}</h2>
        <div className="flex items-center gap-2">
          {action && (
            <Link
              to={action.to}
              className="mr-1 rounded-full px-2 py-1 text-sm font-semibold whitespace-nowrap text-brand-300 transition hover:text-brand-200"
            >
              {action.label}
            </Link>
          )}
          <div className="hidden items-center gap-2 sm:flex">
            <Button
              variant="glass"
              size="icon-sm"
              aria-label="Défiler vers la gauche"
              onClick={() => scroll(-1)}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="glass"
              size="icon-sm"
              aria-label="Défiler vers la droite"
              onClick={() => scroll(1)}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </div>
      <div
        ref={scroller}
        className="row-scroller bleed scrollbar-none flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth pt-1 pb-4"
      >
        {children}
      </div>
    </section>
  );
}
