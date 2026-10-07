/**
 * Client minimal du protocole Chrome DevTools (CDP), sur le WebSocket intégré à Node.js.
 * Juste ce qu'il faut pour piloter un navigateur Chromium installé (Chrome, Edge, Brave…).
 */

type EventHandler = (params: Record<string, unknown>, sessionId: string | undefined) => void;

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
  sessionId?: string;
}

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private closeError: Error | null = null;
  private readonly closeHandlers = new Set<() => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => this.receive(String(event.data)));
    socket.addEventListener('close', () => this.shutdown(new Error('navigateur fermé')));
  }

  static connect(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
    if (typeof WebSocket === 'undefined') {
      return Promise.reject(
        new Error('Node.js 22.4 ou plus récent est nécessaire pour piloter le navigateur'),
      );
    }
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('le navigateur ne répond pas'));
      }, timeoutMs);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve(new CdpConnection(socket));
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('connexion au navigateur impossible'));
        },
        { once: true },
      );
    });
  }

  get closed(): boolean {
    return this.closeError !== null;
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    options: { sessionId?: string; timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.closeError) return Promise.reject(this.closeError);
    const id = this.nextId++;
    const message: CdpMessage = { id, method, params };
    if (options.sessionId) message.sessionId = options.sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} : pas de réponse du navigateur`));
      }, options.timeoutMs ?? 30_000);
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.socket.send(JSON.stringify(message));
    });
  }

  on(event: string, handler: EventHandler): () => void {
    const set = this.handlers.get(event) ?? new Set<EventHandler>();
    set.add(handler);
    this.handlers.set(event, set);
    return () => set.delete(handler);
  }

  onClose(handler: () => void): void {
    if (this.closeError) handler();
    else this.closeHandlers.add(handler);
  }

  close(): void {
    this.socket.close();
    this.shutdown(new Error('connexion au navigateur fermée'));
  }

  private receive(data: string): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(data) as CdpMessage;
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method} : ${message.error.message}`));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method) {
      for (const handler of this.handlers.get(message.method) ?? [])
        handler(message.params ?? {}, message.sessionId);
    }
  }

  private shutdown(error: Error): void {
    if (this.closeError) return;
    this.closeError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const handler of this.closeHandlers) handler();
    this.closeHandlers.clear();
  }
}
