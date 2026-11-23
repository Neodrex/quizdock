import type { Logger } from '@nestjs/common';

/**
 * Scheduled race starts (M7 §1.7), one per room, in this process like the
 * ticker: `recover()` arms them again after a restart. While a start waits,
 * `touch` runs every `touchEveryMs` (the room keeps its TTL). A start time
 * already past fires at once. Timers never keep the process alive, and a
 * failed task is logged, never thrown.
 */
export class EscapeScheduler {
  private readonly rooms = new Map<string, { start: NodeJS.Timeout; touch: NodeJS.Timeout }>();

  constructor(private readonly log: Pick<Logger, 'error'>) {}

  /** Runs `fire` at `at` (epoch ms) for `pin`, replacing what was armed for it. */
  arm(
    pin: string,
    at: number,
    tasks: { fire: () => Promise<void>; touch: () => Promise<void>; touchEveryMs: number },
    now = Date.now(),
  ): void {
    this.disarm(pin);
    const run = (what: string, task: () => Promise<void>) => () =>
      void task().catch((err: Error) => this.log.error(`race ${what} ${pin}: ${err.message}`));
    const start = setTimeout(
      () => {
        this.disarm(pin);
        run('start', tasks.fire)();
      },
      Math.max(0, at - now),
    );
    const touch = setInterval(run('touch', tasks.touch), tasks.touchEveryMs);
    start.unref?.();
    touch.unref?.();
    this.rooms.set(pin, { start, touch });
  }

  disarm(pin: string): void {
    const armed = this.rooms.get(pin);
    if (!armed) return;
    clearTimeout(armed.start);
    clearInterval(armed.touch);
    this.rooms.delete(pin);
  }

  has(pin: string): boolean {
    return this.rooms.has(pin);
  }

  stopAll(): void {
    for (const pin of [...this.rooms.keys()]) this.disarm(pin);
  }
}
