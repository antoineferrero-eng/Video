import { Compass } from 'lucide-react';
import { useServerEvents } from '../../api/events';
import { ButtonLink } from '../ui/Button';
import { EmptyState } from '../ui/States';
import { AppLayout } from './AppLayout';

/** Coquille de l'application : mise en page + abonnement au flux temps réel. */
export function Shell() {
  const { connected } = useServerEvents();
  return <AppLayout connected={connected} />;
}

export function NotFound() {
  return (
    <EmptyState
      icon={<Compass />}
      title="Page introuvable"
      description="Cette page n'existe pas ou a été déplacée."
      action={
        <ButtonLink to="/" variant="primary">
          Retour à l'accueil
        </ButtonLink>
      }
    />
  );
}
