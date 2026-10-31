import { ArrowDownToLine, Link2 } from 'lucide-react';
import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { ButtonLink } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/States';
import { findOneFichierLink } from './links';
import { openOneFichierDialog } from './open-dialog';

/** Fragment de l'adresse décodé (vide s'il est mal encodé). */
function decodeHash(hash: string): string {
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return '';
  }
}

/** Page ouverte par le favori « Envoyer à Lumière » : le lien arrive dans le fragment (« # »). */
export function SendPage() {
  const { hash } = useLocation();
  const link = findOneFichierLink(decodeHash(hash));

  useEffect(() => {
    if (link) openOneFichierDialog(link);
  }, [link]);

  return (
    <EmptyState
      icon={link ? <ArrowDownToLine /> : <Link2 />}
      title={link ? 'Lien 1fichier reçu' : 'Aucun lien 1fichier reçu'}
      description={
        link
          ? 'Confirmez le téléchargement dans la fenêtre ouverte.'
          : 'Le favori « Envoyer à Lumière » s’utilise sur la page 1fichier, ou sur la page du site où le lien 1fichier est affiché. Vous pouvez aussi copier le lien et faire Ctrl+V dans Lumière.'
      }
      action={
        <ButtonLink to="/telechargements" variant="glass">
          Voir les téléchargements
        </ButtonLink>
      }
    />
  );
}
