import type { EscapeScreenFinale } from '@quiz-dock/contracts';
import { CircleCheck, Hourglass } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useMotionLevel } from '../../motion/level';
import { formatClock } from '../team-timer';
import { frameAt, replayMsOf, runTimeAt, splitTableOf, type TeamFrame } from './replay-timeline';

/**
 * The split-time replay (M6 Task 6.12): the race played again once, about 20 s, on
 * `requestAnimationFrame`, then `onDone`. No "Skip": nothing is clicked on a TV. With
 * motion reduced (`fade`) or off (`none`) nothing slides: the split times show as a
 * table (stage × team), held for the replay's length, then `onDone`.
 */
export function SplitReplay({
  finale,
  onDone,
}: {
  finale: EscapeScreenFinale;
  onDone: () => void;
}) {
  const level = useMotionLevel();
  const replayMs = replayMsOf(finale);
  const done = useRef(false);
  const finish = useRef(onDone);
  finish.current = onDone;
  const end = () => {
    if (done.current) return;
    done.current = true;
    finish.current();
  };

  const animated = level === 'full';
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (replayMs === 0) {
      end();
      return;
    }
    if (!animated) {
      const timer = setTimeout(end, replayMs);
      return () => clearTimeout(timer);
    }
    let start: number | null = null;
    let id = requestAnimationFrame(function step(ts) {
      start ??= ts;
      const at = ts - start;
      setElapsed(at);
      if (at >= replayMs) end();
      else id = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(id);
  }, [finale, animated, replayMs]);

  return animated ? (
    <Race finale={finale} t={runTimeAt(finale, elapsed)} />
  ) : (
    <SplitTable finale={finale} />
  );
}

function Race({ finale, t }: { finale: EscapeScreenFinale; t: number }) {
  const { t: tr } = useTranslation('escape');
  const frame = frameAt(finale, t);
  const stageCount = Math.max(1, finale.stages.length);
  return (
    <section
      data-testid="split-replay"
      aria-labelledby="split-replay-title"
      className="flex min-h-0 w-full flex-1 flex-col gap-[0.6em]"
    >
      <div className="flex items-baseline justify-between gap-[1em]">
        <h2 id="split-replay-title" className="text-[1.6em] font-bold">
          {tr('screen.replay.title')}
        </h2>
        <span
          aria-hidden
          data-testid="replay-clock"
          className="font-mono text-[2em] font-bold tabular-nums"
        >
          {formatClock(frame.t)}
        </span>
      </div>
      <ol className="flex min-h-0 flex-1 flex-col justify-center gap-[0.4em]">
        {frame.teams.map((team, i) => (
          <ReplayLane
            key={team.teamId}
            team={team}
            penaltyS={finale.ranking[i].hintPenaltyS}
            stageCount={stageCount}
          />
        ))}
      </ol>
    </section>
  );
}

function ReplayLane({
  team,
  penaltyS,
  stageCount,
}: {
  team: TeamFrame;
  penaltyS: number;
  stageCount: number;
}) {
  const { t } = useTranslation('escape');
  const share = Math.min(1, team.position / stageCount);
  return (
    <li
      data-testid="replay-lane"
      data-team={team.teamId}
      data-finished={team.finished || undefined}
      data-time-up={team.timeUp || undefined}
      className={cn(
        'bg-card text-card-foreground flex min-w-0 items-center gap-[0.8em] rounded-[0.5em] border-[0.1em] px-[0.6em] py-[0.2em]',
        team.timeUp && 'opacity-60 grayscale',
        team.finished && 'border-primary',
      )}
    >
      <span
        data-place
        className="bg-primary text-primary-foreground flex min-w-[2.4em] shrink-0 justify-center rounded-full px-[0.3em] text-[1.1em] font-bold tabular-nums"
      >
        <span className="sr-only">{t('screen.track.placeLabel', { place: team.place })}</span>
        <span aria-hidden="true">{t('screen.track.place', { place: team.place })}</span>
      </span>
      <span className="w-[10em] shrink-0 truncate text-[1.4em] leading-tight font-bold">
        {team.name}
      </span>
      {/* The track: a segment per stage, the marker where the team stood. No text over it. */}
      <div aria-hidden className="bg-muted relative h-[1.2em] min-w-0 flex-1 rounded-[0.3em]">
        {Array.from({ length: stageCount - 1 }, (_, i) => (
          <span
            key={i}
            className="bg-background absolute inset-y-0 w-[0.12em]"
            style={{ left: `${((i + 1) / stageCount) * 100}%` }}
          />
        ))}
        <span
          className="bg-primary absolute inset-y-0 left-0 rounded-[0.3em]"
          style={{ width: `${share * 100}%` }}
        />
        <span
          data-testid="replay-marker"
          className="bg-primary border-background absolute top-1/2 size-[1.4em] -translate-x-1/2 -translate-y-1/2 rounded-full border-[0.15em]"
          style={{ left: `${share * 100}%` }}
        />
      </div>
      <div className="flex w-[11em] shrink-0 items-center justify-end gap-[0.5em] text-[1.1em] font-semibold tabular-nums">
        {team.timeUp ? (
          <span className="flex items-center gap-[0.2em] font-bold">
            <Hourglass aria-hidden className="size-[1em]" />
            {t('screen.track.timeUp')}
          </span>
        ) : (
          <>
            {team.finished && <CircleCheck aria-hidden className="size-[1.1em] shrink-0" />}
            {team.finished && penaltyS > 0 && (
              <span data-testid="replay-penalty" className="text-destructive font-bold">
                <span className="sr-only">
                  {t('screen.replay.penalty', { time: formatClock(penaltyS * 1000) })}
                </span>
                <span aria-hidden="true">+{formatClock(penaltyS * 1000)}</span>
              </span>
            )}
            <span className="font-mono">{formatClock(team.timeMs)}</span>
          </>
        )}
      </div>
    </li>
  );
}

/** The split times without motion: a stage per row, a team per column, `m:ss` at each clear. */
function SplitTable({ finale }: { finale: EscapeScreenFinale }) {
  const { t } = useTranslation('escape');
  const rows = splitTableOf(finale);
  return (
    <table data-testid="split-table" className="w-full table-fixed text-[1.1em] tabular-nums">
      <caption className="pb-[0.4em] text-left text-[1.5em] font-bold">
        {t('screen.replay.tableCaption')}
      </caption>
      <thead>
        <tr>
          <th scope="col" className="w-[30%] text-left font-semibold">
            {t('screen.replay.stage')}
          </th>
          {finale.ranking.map((r) => (
            <th key={r.teamId} scope="col" className="truncate text-left text-[1.2em] font-bold">
              {r.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((cells, i) => (
          <tr key={i} className="border-t-[0.06em]">
            <th scope="row" className="truncate py-[0.2em] text-left font-semibold">
              {finale.stages[i].title}
            </th>
            {cells.map((ms, j) =>
              ms === null ? (
                <td key={j}>
                  <span aria-hidden="true">—</span>
                  <span className="sr-only">{t('screen.replay.notCleared')}</span>
                </td>
              ) : (
                <td key={j} className="font-mono">
                  {formatClock(ms)}
                </td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
