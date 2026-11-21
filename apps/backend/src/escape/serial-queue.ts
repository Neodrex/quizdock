/**
 * One job at a time per key, in order (M3 plan §1.4): the generic version of
 * the engine's per-room chain (game.engine.ts, oneClockCommandAtATime). Every
 * mutation of an escape run goes through it, keyed by game id. Mono-instance.
 */
export class SerialQueue {
  private readonly chains = new Map<string, Promise<void>>();

  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    // A job that failed does not hold back the next one.
    const run = previous.then(job);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, settled);
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return run;
  }

  /** Keys with jobs queued or running. */
  get size(): number {
    return this.chains.size;
  }
}
