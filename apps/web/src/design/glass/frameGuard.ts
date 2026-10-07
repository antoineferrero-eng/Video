/**
 * Garde-fou de fluidité : mesure la durée des images pendant les défilements. Si elle reste
 * trop élevée (machine sans accélération graphique, par exemple), `onSlow` est appelé une
 * seule fois afin de couper l'effet le plus coûteux (la réfraction) pour la session.
 */
const WINDOW = 60;
/** Médiane au-delà de laquelle une fenêtre de mesure est jugée saccadée (≈ 22 images/s). */
const SLOW_FRAME_MS = 45;
const STRIKES = 2;

export function startFrameGuard(onSlow: () => void): () => void {
  let frame = 0;
  let last = 0;
  let idleTimer: number | undefined;
  let samples: number[] = [];
  let strikes = 0;
  let stopped = false;

  const pause = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    samples = [];
  };

  const stop = () => {
    stopped = true;
    pause();
    window.clearTimeout(idleTimer);
    window.removeEventListener('scroll', onScroll);
  };

  const loop = (now: number) => {
    if (last) samples.push(now - last);
    last = now;
    if (samples.length >= WINDOW) {
      const median = [...samples].sort((a, b) => a - b)[Math.floor(WINDOW / 2)] ?? 0;
      samples = [];
      strikes = median > SLOW_FRAME_MS ? strikes + 1 : 0;
      if (strikes >= STRIKES) {
        stop();
        onSlow();
        return;
      }
    }
    frame = requestAnimationFrame(loop);
  };

  function onScroll() {
    if (stopped || document.visibilityState !== 'visible') return;
    if (!frame) {
      last = 0;
      frame = requestAnimationFrame(loop);
    }
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(pause, 250);
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  return stop;
}
