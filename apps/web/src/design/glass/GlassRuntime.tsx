import { useEffect } from 'react';
import { toast } from 'sonner';
import { throttleRefraction, useAppearance } from './appearance';
import { startFrameGuard } from './frameGuard';
import { startDynamicLight } from './light';

/**
 * Effets globaux du verre : lumière dynamique des reflets (selon les préférences et les
 * mouvements réduits) et garde-fou de fluidité qui coupe la réfraction si l'affichage saccade.
 */
export function GlassRuntime() {
  const { lightActive, refractionActive, frameGuard } = useAppearance();

  useEffect(() => (lightActive ? startDynamicLight() : undefined), [lightActive]);

  useEffect(() => {
    if (!refractionActive || !frameGuard) return;
    return startFrameGuard(() => {
      throttleRefraction();
      toast.info('Réfraction désactivée pour préserver la fluidité', {
        description: 'Vous pouvez la réactiver dans Paramètres → Général → Apparence.',
      });
    });
  }, [refractionActive, frameGuard]);

  return null;
}
