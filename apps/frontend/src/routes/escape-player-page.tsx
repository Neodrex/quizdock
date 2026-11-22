import type { EscapePlayerState } from '@quiz-dock/contracts';
import { Hourglass, PartyPopper } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { STAGE_TITLE_ID } from '../game/escape/unlock-moment';
import { formatClock } from '../game/escape/team-timer';

/**
 * The team got out: the last stage's unlock text, its time (frozen at the escape) and
 * the wait for the others. The heading takes the focus the unlock moment hands on.
 */
export function EscapedView({
  state,
  unlockText,
  timeMs,
}: {
  state: EscapePlayerState;
  /** The last stage's unlock text, when this phone saw the escape. */
  unlockText: string | null;
  /** The run's time at the escape. */
  timeMs: number;
}) {
  const { t } = useTranslation('escape');
  return (
    <section className="my-auto flex flex-col items-center gap-4 text-center">
      <PartyPopper aria-hidden className="text-primary size-12" />
      <h1 id={STAGE_TITLE_ID} tabIndex={-1} className="text-[1.5em] font-bold focus:outline-none">
        {t('end.escaped')}
      </h1>
      {unlockText && <p className="text-lg whitespace-pre-line">{unlockText}</p>}
      <p className="text-muted-foreground">
        {t('end.teamTime', { name: state.team?.name ?? '', time: formatClock(timeMs) })}
      </p>
      <p className="text-muted-foreground text-sm">{t('end.waitingOthers')}</p>
    </section>
  );
}

/** The team's time ran out: how far it got. */
export function TimeUpView({ state }: { state: EscapePlayerState }) {
  const { t } = useTranslation('escape');
  const team = state.team;
  return (
    <section className="my-auto flex flex-col items-center gap-4 text-center">
      <Hourglass aria-hidden className="text-muted-foreground size-12" />
      <h1 id={STAGE_TITLE_ID} tabIndex={-1} className="text-[1.5em] font-bold focus:outline-none">
        {t('end.timeUp')}
      </h1>
      {team && (
        <p className="text-muted-foreground">
          {t('end.stagesCleared', { done: team.stageIndex, total: team.stageCount })}
        </p>
      )}
      <p className="text-muted-foreground text-sm">{t('end.waitingOthers')}</p>
    </section>
  );
}
