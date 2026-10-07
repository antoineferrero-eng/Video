/**
 * Lumière dynamique : les reflets spéculaires du verre suivent une source lumineuse placée
 * au pointeur (souris, stylet) ou, sur mobile, l'inclinaison de l'appareil (HIG : « les
 * reflets réagissent au mouvement »). Une seule écoute globale, limitée à une mise à jour
 * par image et aux éléments proches du pointeur.
 */

const INFLUENCE_RADIUS = 520;
const DEFAULT_ANGLE = 135;

/** Angle CSS (0deg = vers le haut) du dégradé d'arête pour une lumière en (lx, ly). */
function angleFrom(lightX: number, lightY: number, centerX: number, centerY: number): number {
  return (Math.atan2(centerX - lightX, -(centerY - lightY)) * 180) / Math.PI;
}

export function startDynamicLight(): () => void {
  let frame = 0;
  let pointer: { x: number; y: number } | null = null;
  let hovered: HTMLElement | null = null;
  const touched = new Set<HTMLElement>();

  const render = () => {
    frame = 0;
    if (!pointer) return;
    const { x, y } = pointer;
    const nearby = new Set<HTMLElement>();
    // Les pastilles décoratives cachées (aria-hidden) gardent l'éclairage par défaut.
    for (const element of document.querySelectorAll<HTMLElement>(
      '.glass:not([aria-hidden="true"])',
    )) {
      const rect = element.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const outsideX = Math.max(rect.left - x, 0, x - rect.right);
      const outsideY = Math.max(rect.top - y, 0, y - rect.bottom);
      if (Math.hypot(outsideX, outsideY) > INFLUENCE_RADIUS) continue;
      nearby.add(element);
      element.style.setProperty(
        '--lg-light-angle',
        `${angleFrom(x, y, centerX, centerY).toFixed(1)}deg`,
      );
    }
    // Les éléments éloignés retrouvent l'éclairage par défaut.
    for (const element of touched) {
      if (!nearby.has(element)) element.style.removeProperty('--lg-light-angle');
    }
    touched.clear();
    for (const element of nearby) touched.add(element);

    if (hovered) {
      const rect = hovered.getBoundingClientRect();
      hovered.style.setProperty('--lg-px', `${(((x - rect.left) / rect.width) * 100).toFixed(1)}%`);
      hovered.style.setProperty('--lg-py', `${(((y - rect.top) / rect.height) * 100).toFixed(1)}%`);
    }
  };

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(render);
  };

  const onPointer = (event: PointerEvent) => {
    pointer = { x: event.clientX, y: event.clientY };
    const target = event.target instanceof Element ? event.target : null;
    const interactive = target?.closest<HTMLElement>('.glass-interactive, [data-glow]') ?? null;
    if (interactive !== hovered) {
      hovered?.style.removeProperty('--lg-px');
      hovered?.style.removeProperty('--lg-py');
      hovered = interactive;
    }
    schedule();
  };

  const onLeave = () => {
    pointer = null;
    hovered?.style.removeProperty('--lg-px');
    hovered?.style.removeProperty('--lg-py');
    hovered = null;
    for (const element of touched) element.style.removeProperty('--lg-light-angle');
    touched.clear();
  };

  // Inclinaison (Android) : fait tourner la lumière globale. iOS exige une autorisation
  // explicite pour ces capteurs : on s'abstient plutôt que d'afficher une demande.
  const root = document.documentElement;
  let tiltAngle: number | null = null;
  let tiltFrame = 0;
  const applyTilt = () => {
    tiltFrame = 0;
    if (tiltAngle !== null)
      root.style.setProperty('--lg-light-angle', `${tiltAngle.toFixed(1)}deg`);
  };
  const onOrientation = (event: DeviceOrientationEvent) => {
    if (event.gamma === null || event.beta === null || document.hidden) return;
    const tilt = Math.max(-40, Math.min(40, event.gamma)) * 1.6;
    const pitch = Math.max(-30, Math.min(30, event.beta - 45)) * 0.6;
    tiltAngle = DEFAULT_ANGLE + tilt - pitch;
    // Les capteurs émettent en continu : une mise à jour par image au plus.
    if (!tiltFrame) tiltFrame = requestAnimationFrame(applyTilt);
  };
  const orientationNeedsPermission =
    typeof DeviceOrientationEvent !== 'undefined' && 'requestPermission' in DeviceOrientationEvent;

  window.addEventListener('pointermove', onPointer, { passive: true });
  window.addEventListener('pointerdown', onPointer, { passive: true });
  // Pointeur sorti de la fenêtre.
  const onOut = (event: PointerEvent) => {
    if (!event.relatedTarget) onLeave();
  };
  document.addEventListener('pointerout', onOut);
  if (!orientationNeedsPermission)
    window.addEventListener('deviceorientation', onOrientation, { passive: true });

  return () => {
    cancelAnimationFrame(frame);
    cancelAnimationFrame(tiltFrame);
    window.removeEventListener('pointermove', onPointer);
    window.removeEventListener('pointerdown', onPointer);
    document.removeEventListener('pointerout', onOut);
    window.removeEventListener('deviceorientation', onOrientation);
    onLeave();
    root.style.removeProperty('--lg-light-angle');
  };
}
