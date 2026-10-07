import { EventEmitter } from 'node:events';
import type { ServerEvent } from '@lumiere/shared';

export type ServerEventListener = (event: ServerEvent) => void;

/** Bus d'événements interne : les services publient, le flux SSE (et les tests) s'abonnent. */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(event: ServerEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: ServerEventListener): () => void {
    const safeListener: ServerEventListener = (event) => {
      try {
        listener(event);
      } catch {
        // Un abonné défaillant ne doit jamais casser l'émetteur.
      }
    };
    this.emitter.on('event', safeListener);
    return () => this.emitter.off('event', safeListener);
  }
}
