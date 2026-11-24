import type { EscapeTeamUpdate } from '@quiz-dock/contracts';
import type { GameId } from '../game/game.keys';

/**
 * Task 9.3: what a host room waits for, of one run: the teams that changed and
 * their updates, oldest first. It goes out with the next held send, as one frame.
 */
export interface HostNews {
  id: GameId;
  teams: Set<string>;
  updates: EscapeTeamUpdate[];
}

/** What a held send carries: the board, the host state, the host's news. */
export interface Held {
  board: boolean;
  host: boolean;
  news?: HostNews | null;
}

/**
 * Who a lane's sends reach. `all`: the board to the screens and the host, and the
 * host's state and news (group play's board, a race's every frame); `screens`:
 * the board to the screens only; `host`: the board, state and news to the host
 * only (a hosted event's console, which keeps a period of its own).
 */
export type HeldLane = 'all' | 'screens' | 'host';

/** Both runs' news together, `a` first (it may be changed); news of an older run is dropped. */
export function mergeNews(a: HostNews | null | undefined, b: HostNews | null | undefined) {
  if (!b) return a ?? null;
  if (!a || a.id !== b.id) return { id: b.id, teams: new Set(b.teams), updates: [...b.updates] };
  for (const t of b.teams) a.teams.add(t);
  a.updates.push(...b.updates);
  return a;
}

/** `a` then `b`, as one send. */
function mergeHeld(a: Held, b: Held): Held {
  return { board: a.board || b.board, host: a.host || b.host, news: mergeNews(a.news, b.news) };
}

const nothing = (): Held => ({ board: false, host: false, news: null });
const isEmpty = (h: Held) => !h.board && !h.host && !h.news;

interface Entry {
  pin: string;
  lane: HeldLane;
  everyMs: number;
  /** Asked for since the last send. */
  held: Held;
  /** What a flush is sending while it reads its view; null otherwise. */
  flushing: Held | null;
  /** That flush, while it runs. */
  inflight?: Promise<void>;
  timer?: NodeJS.Timeout;
}

/** What the throttle needs of the engine. */
export interface HeldSendsIo<V> {
  /** Sends `what` of a lane with view `v`; whether anything went out. */
  send(pin: string, lane: HeldLane, v: V, what: Held): boolean;
  /** The room's view now; null when the room or its run is gone. */
  load(pin: string): Promise<V | null>;
  warn(message: string): void;
}

/**
 * The board throttle per room and lane (M7 §1.7, M9 Task 9.3): a send goes out at
 * once, then nothing for the lane's period; what is asked for meanwhile is merged
 * and goes out at the period's end, with a view read then. The entry stays while
 * that flush reads its view, so news asked for meanwhile waits behind it and the
 * order holds. A failed flush keeps what it held for the next. An entry removes
 * itself once a period passes with nothing asked, so nothing stays behind a room.
 */
export class HeldSends<V> {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly io: HeldSendsIo<V>) {}

  request(pin: string, lane: HeldLane, v: V, what: Held, everyMs: number): void {
    const key = keyOf(pin, lane);
    const e = this.entries.get(key);
    if (e) {
      e.held = mergeHeld(e.held, what);
      return;
    }
    this.io.send(pin, lane, v, what);
    const fresh: Entry = { pin, lane, everyMs, held: nothing(), flushing: null };
    this.entries.set(key, fresh);
    this.arm(key, fresh);
  }

  /** Whether a lane of the room holds anything (tests: nothing stays behind a room). */
  has(pin: string): boolean {
    return (['all', 'screens', 'host'] as const).some((l) => this.entries.has(keyOf(pin, l)));
  }

  /**
   * A lane's held and in-flight sends, oldest first, for the caller to send now
   * (before a finale); the entry goes, and a flush in flight sends nothing.
   */
  take(pin: string, lane: HeldLane): Held | null {
    const key = keyOf(pin, lane);
    const e = this.entries.get(key);
    if (!e) return null;
    clearTimeout(e.timer);
    this.entries.delete(key);
    const what = e.flushing ? mergeHeld(e.flushing, e.held) : e.held;
    return isEmpty(what) ? null : what;
  }

  /**
   * What a lane holds goes out now (after a flush in flight), with a view read
   * now, and a fresh period starts: a host command's own result does not wait.
   */
  async flushNow(pin: string, lane: HeldLane): Promise<void> {
    const key = keyOf(pin, lane);
    const busy = this.entries.get(key)?.inflight;
    if (busy) await busy;
    const e = this.entries.get(key);
    if (!e || isEmpty(e.held)) return;
    clearTimeout(e.timer);
    await this.fire(key, e);
  }

  clear(): void {
    for (const e of this.entries.values()) clearTimeout(e.timer);
    this.entries.clear();
  }

  private arm(key: string, e: Entry): void {
    e.timer = setTimeout(() => void this.fire(key, e), e.everyMs);
    e.timer.unref?.();
  }

  private fire(key: string, e: Entry): Promise<void> {
    if (this.entries.get(key) !== e) return Promise.resolve();
    if (isEmpty(e.held)) {
      this.entries.delete(key);
      return Promise.resolve();
    }
    const what = e.held;
    e.held = nothing();
    e.flushing = what;
    e.inflight = this.flush(key, e, what);
    return e.inflight;
  }

  private async flush(key: string, e: Entry, what: Held): Promise<void> {
    try {
      const v = await this.io.load(e.pin);
      // Taken meanwhile (a finale): the taker sent it.
      if (this.entries.get(key) !== e) return;
      if (v) this.io.send(e.pin, e.lane, v, what);
    } catch (err) {
      this.io.warn(`board ${e.pin}: ${(err as Error).message}`);
      if (this.entries.get(key) === e) e.held = mergeHeld(what, e.held);
    } finally {
      e.flushing = null;
      e.inflight = undefined;
    }
    if (this.entries.get(key) === e) this.arm(key, e);
  }
}

const keyOf = (pin: string, lane: HeldLane) => `${lane}:${pin}`;
