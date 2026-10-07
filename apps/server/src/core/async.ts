/** Attend `ms` millisecondes (interrompu proprement par un AbortSignal). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Limite le nombre de tâches asynchrones exécutées simultanément. */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

/** Exécute `mapper` sur chaque élément avec une concurrence bornée, en conservant l'ordre. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/** Mutualise les appels concurrents portant sur une même clé (une seule exécution en vol). */
export class InFlight<K, V> {
  private readonly pending = new Map<K, Promise<V>>();

  run(key: K, task: () => Promise<V>): Promise<V> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = task().finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}

/** Seau à jetons partagé : limite le débit global (octets/seconde) de plusieurs flux. */
export class RateLimiter {
  private bytesPerSecond = 0;
  private tokens = 0;
  private last = Date.now();

  setLimit(bytesPerSecond: number): void {
    this.bytesPerSecond = Math.max(0, bytesPerSecond);
    this.tokens = Math.min(this.tokens, this.bytesPerSecond);
    this.last = Date.now();
  }

  get limit(): number {
    return this.bytesPerSecond;
  }

  async consume(bytes: number, signal?: AbortSignal): Promise<void> {
    if (this.bytesPerSecond <= 0) return;
    const now = Date.now();
    this.tokens = Math.min(
      this.bytesPerSecond,
      this.tokens + ((now - this.last) / 1000) * this.bytesPerSecond,
    );
    this.last = now;
    this.tokens -= bytes;
    if (this.tokens < 0) {
      await sleep((-this.tokens / this.bytesPerSecond) * 1000, signal);
    }
  }
}

/** Cache mémoire simple avec durée de vie et taille bornée (éviction LRU). */
export class TtlCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();

  constructor(
    private readonly maxEntries: number,
    private readonly defaultTtlMs: number,
  ) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs = this.defaultTtlMs): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
