import type { EscapeBoard } from '@quiz-dock/contracts';
import { DoorOpen, Pause } from 'lucide-react';
import { motion as m } from 'motion/react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useMotionLevel } from '../../motion/level';
import { formatClock } from '../team-timer';
import { finalMsOf, LAST_SECONDS_MS, showClockOf } from './screen-reducer';

/**
 * The run clock (M6 Task 6.10): the time left to the latest deadline of the teams
 * still playing, on the screen's one tick (`now`, server time). In the final minutes it
 * doubles in size, takes the warning colour and says "Final minutes" (never colour
 * alone), and at full motion pulses once a second. The last 10 s show whole seconds.
 * Paused: frozen with a "Paused" badge. Every team out: the clock stops and says so.
 */
export function ShowClock({ board, now }: { board: EscapeBoard; now: number }) {
  const { t } = useTranslation('escape');
  const level = useMotionLevel();
  const show = showClockOf(board, now);
  const allOut =
    board.phase === 'running' &&
    board.teams.length > 0 &&
    board.teams.every((tm) => tm.escaped || tm.timedOut);
  const remainingMs = show
    ? show.remainingMs
    : allOut
      ? Math.max(0, ...board.teams.map((tm) => tm.remainingMs))
      : 0;
  const total = Math.ceil(Math.max(0, remainingMs) / 1000);
  // The spoken label moves once a minute, as the phone's timer: a screen reader is not
  // kept talking.
  const [labelAt, setLabelAt] = useState(total);
  if (Math.floor(labelAt / 60) !== Math.floor(total / 60)) setLabelAt(total);
  if (!show && !allOut) return null;

  const final = !!show && show.remainingMs <= finalMsOf(board.clock.limitMs);
  const last = !!show && show.remainingMs <= LAST_SECONDS_MS;
  const paused = !!show?.paused;
  const pulse = final && !paused && level === 'full';
  const label = t('timer.label', {
    minutes: t('timer.minutes', { count: Math.floor(labelAt / 60) }),
    seconds: t('timer.seconds', { count: labelAt % 60 }),
  });
  const digits = {
    'aria-hidden': true,
    'data-testid': 'show-clock-digits',
    className: cn(
      'font-mono leading-none font-bold tabular-nums',
      final ? 'text-destructive text-[8em]' : 'text-[4em]',
    ),
    children: last ? String(total) : formatClock(remainingMs),
  };
  return (
    <div
      role="timer"
      aria-label={label}
      data-final={final}
      className="flex shrink-0 flex-col items-center gap-[0.2em]"
    >
      {/* The pulse grows the digits by 4% once a second; it never fades them (7:1).
          Without it, a plain span: no transform at all. */}
      {pulse ? (
        <m.span
          {...digits}
          data-pulse="scale"
          animate={{ scale: [1, 1.04, 1] }}
          transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
        />
      ) : (
        <span {...digits} />
      )}
      {paused ? (
        <span className="flex items-center gap-[0.3em] text-[1.4em] font-bold">
          <Pause aria-hidden className="size-[1em]" />
          {t('timer.paused')}
        </span>
      ) : allOut ? (
        <span className="flex items-center gap-[0.3em] text-[1.4em] font-bold">
          <DoorOpen aria-hidden className="size-[1em]" />
          {t('screen.clock.allOut')}
        </span>
      ) : final ? (
        <span className="text-destructive text-[1.4em] font-bold uppercase">
          {t('screen.clock.finalMinutes')}
        </span>
      ) : null}
    </div>
  );
}
