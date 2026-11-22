import type { EscapeFinale } from '@quiz-dock/contracts';
import { Link } from '@tanstack/react-router';
import { Award, Trophy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatClock } from './team-timer';

type Awards = EscapeFinale['awards'];
const AWARDS: (keyof Awards)[] = ['fastest', 'fewestHints', 'teamwork', 'photoFinish'];

/**
 * The run's results, as the server ranked them: places, times or stages cleared,
 * hints (paid ones in brackets), the awards, and the player's team marked. Once the
 * room has closed, a way on to another room.
 */
export function EscapeFinaleView({
  finale,
  myTeamId,
  closed,
}: {
  finale: EscapeFinale;
  /** The phone's team: from the state, or the record after a reload. */
  myTeamId: string | null;
  /** The room ended after the finale (`ended: 'final'`). */
  closed: boolean;
}) {
  const { t } = useTranslation('escape');
  const nameOf = (id: string) => finale.ranking.find((r) => r.teamId === id)?.name ?? '';
  const awards = AWARDS.flatMap((k) => {
    const v = finale.awards[k];
    if (!v) return [];
    const names = Array.isArray(v) ? v.map(nameOf).join(' · ') : nameOf(v);
    return [{ key: k, names }];
  });
  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-col items-center gap-2 text-center">
        <Trophy aria-hidden className="text-primary size-10" />
        <h1 className="text-[1.4em] font-bold">{finale.title}</h1>
        {finale.finale && (
          <p className="text-muted-foreground whitespace-pre-line">{finale.finale}</p>
        )}
      </div>
      <ol aria-label={t('finale.ranking')} className="flex flex-col gap-2">
        {finale.ranking.map((r) => {
          const mine = r.teamId === myTeamId;
          return (
            <li
              key={r.teamId}
              aria-current={mine || undefined}
              className={cn(
                'bg-card flex items-center gap-3 rounded-lg border px-4 py-3',
                mine && 'border-primary ring-primary/30 ring-2',
              )}
            >
              <span className="w-8 text-xl font-bold tabular-nums">{r.place}</span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-semibold">
                  {r.name}
                  {mine && (
                    <span className="text-primary ml-2 text-xs font-medium">
                      {t('finale.yourTeam')}
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground text-sm">
                  {r.paidHints > 0
                    ? t('finale.hintsPaid', { count: r.hintsUsed, paid: r.paidHints })
                    : t('finale.hints', { count: r.hintsUsed })}
                </span>
              </span>
              <span className="text-right font-mono font-semibold tabular-nums">
                {r.escaped && r.scoreMs !== null
                  ? formatClock(r.scoreMs)
                  : t('finale.stages', { done: r.stagesCleared })}
              </span>
            </li>
          );
        })}
      </ol>
      {awards.length > 0 && (
        <ul aria-label={t('finale.awards')} className="flex flex-col gap-2">
          {awards.map((a) => (
            <li key={a.key} className="flex items-center gap-2 text-sm">
              <Award aria-hidden className="text-primary size-4 shrink-0" />
              <span className="font-medium">{t(`finale.award.${a.key}`)}</span>
              <span className="text-muted-foreground">{a.names}</span>
            </li>
          ))}
        </ul>
      )}
      {closed && (
        <div className="flex flex-col items-center gap-3 text-center">
          <p className="text-muted-foreground">{t('finale.closed')}</p>
          <Link to="/join" className={cn(buttonVariants({ size: 'lg' }), 'min-h-12 w-full')}>
            {t('finale.joinAnother')}
          </Link>
        </div>
      )}
    </section>
  );
}
