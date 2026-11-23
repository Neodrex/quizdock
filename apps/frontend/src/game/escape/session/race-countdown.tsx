import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatClock } from '../team-timer';
import { useNow } from '../use-now';

/**
 * The lobby's countdown to a scheduled race start, on the server's clock:
 * "Starts in 4:59", then "Starting…" once it is due (the server starts the race).
 */
export function RaceCountdown({ startsAt, className }: { startsAt: number; className?: string }) {
  const { t } = useTranslation('escape');
  const now = useNow(1000);
  const left = startsAt - now;
  return (
    <p role="timer" aria-live="off" className={cn('font-semibold tabular-nums', className)}>
      {left > 0
        ? t('race.countdown.startsIn', { time: formatClock(left) })
        : t('race.countdown.starting')}
    </p>
  );
}
