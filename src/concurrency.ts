export class BusyError extends Error {}

/** FIFO, bounded global queue; requests in the same Discord scope are serialized. */
export class RequestQueue {
  private active = 0;
  private keys = new Set<string>();
  private pending: { key: string; start: () => void; reject: (error: Error) => void }[] = [];
  private closed = false;
  constructor(private concurrency: number, private maxQueued: number) {}
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    if (this.closed || ((this.active >= this.concurrency || this.keys.has(key)) && this.pending.length >= this.maxQueued)) {
      return Promise.reject(new BusyError('Request queue is full'));
    }
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active++; this.keys.add(key);
        void task().then(resolve, reject).finally(() => {
          this.active--; this.keys.delete(key); this.drain();
        });
      };
      this.pending.push({ key, start, reject }); this.drain();
    });
  }
  private drain() {
    while (this.active < this.concurrency) {
      const index = this.pending.findIndex(item => !this.keys.has(item.key));
      if (index < 0) return;
      this.pending.splice(index, 1)[0]!.start();
    }
  }
  async close() {
    this.closed = true;
    for (const item of this.pending.splice(0)) item.reject(new BusyError('Request queue closed'));
    while (this.active) await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** Stop waiting promptly on abort, including when a Discord REST call is rate-limit queued. */
export function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Request aborted'));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

/** Serializes repository tool operations with Git updates. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => {});
    return result;
  }
}
