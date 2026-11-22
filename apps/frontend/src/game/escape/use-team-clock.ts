import { useEffect, useRef, useState } from 'react';
import { serverNow } from '../clock';

/** The team's clock as the phone gets it (`EscapePlayerState.team` and `clock.paused`). */
export interface TeamClockInput {
  /** Server epoch ms; null when paused, ended, escaped or timed out. */
  deadlineAt: number | null;
  /** What was left when the state was built: shown as is while there is no deadline. */
  remainingMs: number;
  paused: boolean;
}

/** Warnings, in minutes left. */
const WARNINGS = [5, 1];

/**
 * The team's time left, counted on the server's clock to its deadline, so a reload or
 * a late state shows the same as every teammate. Frozen without a deadline. Each
 * warning fires when the time left crosses it going down: a deadline moved later
 * (extra time) lifts the time back above a threshold, which arms it again.
 */
export function useTeamClock(
  input: TeamClockInput,
  onWarning?: (minutes: number) => void,
): { remainingMs: number; paused: boolean } {
  const { deadlineAt, remainingMs, paused } = input;
  const [now, setNow] = useState(() => serverNow());

  useEffect(() => {
    if (deadlineAt === null) return;
    setNow(serverNow());
    const id = setInterval(() => {
      const t = serverNow();
      setNow(t);
      if (t >= deadlineAt) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [deadlineAt]);

  const left = deadlineAt === null ? Math.max(0, remainingMs) : Math.max(0, deadlineAt - now);

  // The last time left seen while counting; null when frozen, so a resume does not warn.
  const prevRef = useRef<number | null>(null);
  const warnRef = useRef(onWarning);
  warnRef.current = onWarning;
  const counting = deadlineAt !== null;
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = counting ? left : null;
    if (!counting || prev === null) return;
    for (const m of WARNINGS) {
      if (prev > m * 60_000 && left <= m * 60_000) warnRef.current?.(m);
    }
  }, [left, counting]);

  return { remainingMs: left, paused };
}
