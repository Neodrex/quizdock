import { Pause } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/** "4:59", or "1:02:05" from an hour up; seconds rounded up, so 0:00 is the end. */
export function formatClock(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * The team's time left. Its spoken label moves once a minute, not every second, so a
 * screen reader is not kept talking; the warnings are said by the announcer.
 */
export function TeamTimer({ remainingMs, paused }: { remainingMs: number; paused: boolean }) {
  const { t } = useTranslation('escape');
  const total = Math.ceil(Math.max(0, remainingMs) / 1000);
  // The seconds the label was last written at: rewritten when the minute changes.
  const [labelAt, setLabelAt] = useState(total);
  if (Math.floor(labelAt / 60) !== Math.floor(total / 60)) setLabelAt(total);
  const label = t('timer.label', {
    minutes: t('timer.minutes', { count: Math.floor(labelAt / 60) }),
    seconds: t('timer.seconds', { count: labelAt % 60 }),
  });
  const warning = total <= 60 ? 'last-minute' : total <= 300 ? 'last-minutes' : undefined;
  return (
    <div
      role="timer"
      aria-label={label}
      data-warning={warning}
      className={cn(
        'flex items-center gap-1.5 font-mono text-lg font-semibold tabular-nums',
        warning === 'last-minutes' && 'text-amber-600 dark:text-amber-400',
        warning === 'last-minute' && 'text-destructive',
      )}
    >
      {paused && <Pause aria-hidden className="size-4" />}
      <span aria-hidden>{formatClock(remainingMs)}</span>
      {paused && <span className="text-sm font-normal">{t('timer.paused')}</span>}
    </div>
  );
}
