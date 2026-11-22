import type { EscapeScreenFinale } from '@quiz-dock/contracts';
import { AlarmClockPlus, CircleCheck, Hourglass } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useMotionLevel } from '../../motion/level';
import { formatClock } from '../team-timer';
import { COLUMN_CLASS, laneScaleOf, TALL_LANES_MAX } from './screen-layout';
import {
  frameAt,
  replayMsOf,
  replayTeamsOf,
  runTimeAt,
  splitTableOf,
  type TeamFrame,
} from './replay-timeline';

type Ranked = EscapeScreenFinale['ranking'][number];

/**
 * The split-time replay (M6 Task 6.12): the race played again once, about 20 s, on
 * `requestAnimationFrame`, then `onDone`. No "Skip": nothing is clicked on a TV. With
 * motion reduced (`fade`) or off (`none`) nothing slides: the split times show as a
 * table (stage × team), held for the replay's length, then `onDone`. Lanes and columns
 * keep the team order; never a scroll (§1.8): two compact columns for 13–30 teams,
 * above that the top 12 and how many more. A new finale (pushed again) replays.
 */
/**
 * The widest em a replay lane fits at: 1em on a 4:3 screen, where the screen's base
 * (2.6vmin) is 2.6vh, that is 1.95vw.
 */
const REPLAY_FIT_VW = 1.95;

export function SplitReplay({
  finale,
  onDone,
}: {
  finale: EscapeScreenFinale;
  onDone: () => void;
}) {
  // Each finale pushed is a run of its own: a fresh clock, a fresh `onDone`.
  const [run, setRun] = useState({ finale, n: 0 });
  if (run.finale !== finale) setRun({ finale, n: run.n + 1 });
  return <ReplayRun key={run.n} finale={finale} onDone={onDone} />;
}

function ReplayRun({ finale, onDone }: { finale: EscapeScreenFinale; onDone: () => void }) {
  const level = useMotionLevel();
  const replayMs = replayMsOf(finale);
  const done = useRef(false);
  const finish = useRef(onDone);
  useEffect(() => {
    finish.current = onDone;
  }, [onDone]);

  const animated = level === 'full';
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const end = () => {
      if (done.current) return;
      done.current = true;
      finish.current();
    };
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
  }, [animated, replayMs]);

  return animated ? (
    <Race finale={finale} t={runTimeAt(finale, elapsed)} />
  ) : (
    <SplitTables finale={finale} />
  );
}

function More({ count }: { count: number }) {
  const { t } = useTranslation('escape');
  if (count <= 0) return null;
  return (
    <p data-testid="replay-more" className="shrink-0 text-[1.1em] font-semibold">
      {t('screen.track.more', { count })}
    </p>
  );
}

function Race({ finale, t }: { finale: EscapeScreenFinale; t: number }) {
  const { t: tr } = useTranslation('escape');
  const frame = frameAt(finale, t);
  const { teams, columns, more } = replayTeamsOf(finale);
  const byId = new Map(frame.teams.map((x) => [x.teamId, x]));
  const lanes = teams.map((r) => byId.get(r.teamId)!);
  const compact = columns > 1;
  const dense = columns > 2;
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
      <ol
        data-testid="replay-lanes"
        data-columns={columns}
        data-flow={compact ? 'column' : undefined}
        className={cn(
          'min-h-0 flex-1 gap-[0.4em]',
          compact
            ? cn('grid grid-flow-col gap-x-[0.8em]', COLUMN_CLASS[columns])
            : 'flex flex-col justify-center',
        )}
        style={
          compact
            ? {
                gridTemplateRows: `repeat(${Math.ceil(lanes.length / columns)}, minmax(0, 1fr))`,
              }
            : lanes.length <= TALL_LANES_MAX
              ? // A small race replays bigger, as the race track scales it, but its lanes
                // have fixed columns: never wider than what fits a 4:3 projector at 1em.
                { fontSize: `min(${laneScaleOf(lanes.length)}em, ${REPLAY_FIT_VW}vw)` }
              : undefined
        }
      >
        {lanes.map((team) => (
          <ReplayLane
            key={team.teamId}
            team={team}
            stageCount={stageCount}
            compact={compact}
            dense={dense}
          />
        ))}
      </ol>
      <More count={more} />
    </section>
  );
}

function ReplayLane({
  team,
  stageCount,
  compact,
  dense,
}: {
  team: TeamFrame;
  stageCount: number;
  compact: boolean;
  /** Three or four columns: the penalty by its icon, the words for screen readers. */
  dense: boolean;
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
        'bg-card text-card-foreground flex min-h-0 min-w-0 items-center overflow-hidden rounded-[0.5em] border-[0.1em]',
        dense
          ? 'gap-[0.3em] px-[0.3em]'
          : compact
            ? 'gap-[0.5em] px-[0.6em]'
            : 'gap-[0.8em] px-[0.6em] py-[0.2em]',
        // Greyed, never faded: faded text would fall under 7:1. "Time up" says it too.
        team.timeUp && 'border-dashed grayscale',
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
      <span
        className={cn(
          'truncate text-[1.4em] leading-tight font-bold',
          dense ? 'w-[3.5em] min-w-0 shrink' : compact ? 'w-[6em] shrink-0' : 'w-[10em] shrink-0',
        )}
      >
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
      <div
        className={cn(
          'flex shrink-0 items-center justify-end gap-[0.5em] text-[1.1em] font-semibold tabular-nums',
          dense ? 'w-auto' : compact ? 'w-[8em]' : 'w-[11em]',
        )}
      >
        {team.timeUp ? (
          <span className="flex items-center gap-[0.2em] font-bold">
            <Hourglass aria-hidden className="size-[1em]" />
            {t('screen.track.timeUp')}
          </span>
        ) : (
          <>
            {/* Dense: the check goes, the penalty stays in sight (the time says finished). */}
            {team.finished && !dense && (
              <CircleCheck aria-hidden className="size-[1.1em] shrink-0" />
            )}
            {team.finished && team.penaltyS > 0 && (
              // The words in the card's own colour (contrast); the red is the icon's.
              <span
                data-testid="replay-penalty"
                className="flex items-center gap-[0.1em] font-bold"
              >
                <AlarmClockPlus aria-hidden className="text-destructive size-[1em]" />
                <span className="sr-only">
                  {t('screen.replay.penalty', { time: formatClock(team.penaltyS * 1000) })}
                </span>
                <span aria-hidden="true">+{formatClock(team.penaltyS * 1000)}</span>
              </span>
            )}
            <span className="font-mono">{formatClock(team.timeMs)}</span>
          </>
        )}
      </div>
    </li>
  );
}

/**
 * The split times without motion: a row per shown team, a column per stage; past 5
 * teams, up to 4 tables side by side of at most 8 rows each (screen-layout.ts).
 */
function SplitTables({ finale }: { finale: EscapeScreenFinale }) {
  const { t } = useTranslation('escape');
  const { teams, columns, more } = replayTeamsOf(finale);
  const per = Math.ceil(teams.length / columns);
  const groups = Array.from({ length: columns }, (_, g) => teams.slice(g * per, (g + 1) * per));
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-[0.4em]">
      <h2 id="split-table-title" className="text-[1.5em] font-bold">
        {t('screen.replay.tableCaption')}
      </h2>
      <div className="flex min-h-0 gap-[1em]">
        {groups
          .filter((group) => group.length > 0)
          .map((group, g) => (
            <SplitTable key={g} finale={finale} teams={group} compact={columns > 1} />
          ))}
      </div>
      <More count={more} />
    </div>
  );
}

function SplitTable({
  finale,
  teams,
  compact,
}: {
  finale: EscapeScreenFinale;
  teams: Ranked[];
  compact: boolean;
}) {
  const { t } = useTranslation('escape');
  const rows = splitTableOf(finale, teams);
  const cell = compact ? 'text-[0.9em]' : 'text-[1.1em]';
  return (
    <table
      data-testid="split-table"
      aria-labelledby="split-table-title"
      className="min-w-0 flex-1 table-fixed tabular-nums"
    >
      <thead>
        <tr>
          <th scope="col" className={cn('w-[30%] truncate text-left font-semibold', cell)}>
            {t('screen.replay.team')}
          </th>
          {finale.stages.map((stage, i) => (
            <th key={i} scope="col" className={cn('truncate text-left font-semibold', cell)}>
              {stage.title}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((cells, i) => (
          <tr key={teams[i].teamId} className="border-t-[0.06em]">
            {/* Team names at 1.4em, as everywhere on the screen; the times smaller. */}
            <th scope="row" className="truncate py-[0.1em] text-left text-[1.4em] font-bold">
              {teams[i].name}
            </th>
            {cells.map((ms, j) =>
              ms === null ? (
                <td key={j} className={cell}>
                  <span aria-hidden="true">—</span>
                  <span className="sr-only">{t('screen.replay.notCleared')}</span>
                </td>
              ) : (
                <td key={j} className={cn('font-mono', cell)}>
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
