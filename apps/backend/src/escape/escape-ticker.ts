import type { Logger } from '@nestjs/common';

/**
 * One interval per running escape run (M3 plan, Task 3.11), as RoomTimers for
 * quizdock's rooms: a tick only triggers work, and the task re-reads the run
 * before doing anything. Ticks never overlap (a tick still running makes the
 * next one skip), intervals never keep the process alive, and a failed tick is
 * logged, never thrown.
 */
export class EscapeTicker {
  private readonly runs = new Map<string, NodeJS.Timeout>();

  constructor(private readonly log: Pick<Logger, 'error'>) {}

  /** Ticks `task` every `everyMs` for `key`, replacing any interval it had. */
  start(key: string, everyMs: number, task: () => Promise<void>): void {
    this.stop(key);
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      task()
        .catch((err: Error) => this.log.error(`escape tick ${key}: ${err.message}`))
        .finally(() => (busy = false));
    }, everyMs);
    timer.unref?.();
    this.runs.set(key, timer);
  }

  stop(key: string): void {
    const timer = this.runs.get(key);
    if (!timer) return;
    clearInterval(timer);
    this.runs.delete(key);
  }

  has(key: string): boolean {
    return this.runs.has(key);
  }

  stopAll(): void {
    for (const key of [...this.runs.keys()]) this.stop(key);
  }
}
