/** Bounded SSH polling with single-flight per node and capped exponential backoff. */
export class NodeMonitor {
  private active = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  private schedule = new Map<string, { due: number; failures: number }>();
  private stopped = false;
  constructor(
    private probe: (id: string, signal: AbortSignal) => Promise<void>,
    private clock = Date.now,
  ) {}
  refresh(id: string): Promise<void> {
    const current = this.active.get(id);
    if (current) return current.promise;
    if (this.stopped) return Promise.reject(new Error('Monitor stopped'));
    if (this.active.size >= 2)
      return Promise.reject(new Error('Two node checks already in progress; retry shortly'));
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20000);
    const promise = Promise.resolve()
      .then(() => this.probe(id, abort.signal))
      .then(
        () => {
          this.schedule.set(id, { due: this.clock() + 15000, failures: 0 });
        },
        (error) => {
          const failures = Math.min(4, (this.schedule.get(id)?.failures ?? 0) + 1);
          this.schedule.set(id, {
            due: this.clock() + Math.min(120000, 15000 * 2 ** failures),
            failures,
          });
          throw error;
        },
      )
      .finally(() => {
        clearTimeout(timer);
        this.active.delete(id);
      });
    this.active.set(id, { abort, promise });
    return promise;
  }
  async poll(ids: string[]) {
    if (this.stopped) return;
    const pending: Promise<void>[] = [];
    for (const id of [...ids].sort(
      (a, b) => (this.schedule.get(a)?.due ?? 0) - (this.schedule.get(b)?.due ?? 0),
    )) {
      if (this.active.size >= 2) break;
      if (!this.active.has(id) && (this.schedule.get(id)?.due ?? 0) <= this.clock())
        pending.push(this.refresh(id));
    }
    await Promise.allSettled(pending);
  }
  async stop() {
    this.stopped = true;
    for (const entry of this.active.values()) entry.abort.abort();
    await Promise.allSettled([...this.active.values()].map((entry) => entry.promise));
  }
}
