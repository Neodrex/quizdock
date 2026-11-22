import type { EscapeBoard } from '@quiz-dock/contracts';
import { CircleCheck, Hourglass, Lightbulb, WifiOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { type MotionLevel, useMotionLevel } from '../../motion/level';
import { formatClock } from '../team-timer';
import {
  COLUMN_CLASS,
  laneScaleOf,
  lanesLayoutOf,
  TALL_LANE_MAX_EM,
  TALL_LANES_MAX,
} from './screen-layout';
import { type Lane, lanesOf, ownTimeOf, showClockOf } from './screen-reducer';

/**
 * The race while it runs (M6 Task 6.8): one lane per team in team order (owner
 * question 5), each with its live place, a segment per stage, the current stage's
 * locks and title, hints used, and its own time only when it differs from the run
 * clock (extra time). Colour is never the only signal: states carry icons and words.
 */
export function RaceTrack({ board, now }: { board: EscapeBoard; now: number }) {
  const { t } = useTranslation('escape');
  const motion = useMotionLevel();
  const all = lanesOf(board);
  const show = showClockOf(board, now);
  // Never a scroll (screen-layout.ts): wide lanes up to 5 teams, then one-line lanes
  // in up to 4 columns; above 30 teams, the leaders and a count.
  const layout = lanesLayoutOf(all.length);
  const compact = !layout.wide;
  // The leaders, kept in team order so a lane does not jump about.
  const top =
    layout.shown < all.length
      ? new Set(
          [...all]
            .sort((a, b) => a.place - b.place)
            .slice(0, layout.shown)
            .map((l) => l.id),
        )
      : null;
  const lanes = top ? all.filter((l) => top.has(l.id)) : all;
  // A small race fills the screen: bigger lanes, the stages on a row of their own.
  const tall = lanes.length <= TALL_LANES_MAX;
  const scale = tall ? laneScaleOf(lanes.length) : 1;
  const rest = top ? all.filter((l) => !top.has(l.id)) : [];
  return (
    <div className="flex h-full min-h-0 flex-col gap-[0.6em]">
      <ol
        aria-label={t('screen.track.label')}
        data-compact={compact || undefined}
        data-tall={tall || undefined}
        data-columns={layout.columns}
        // Down each column, then across, as the replay: a team keeps its cell.
        data-flow="column"
        style={{
          gridTemplateRows: `repeat(${Math.max(1, Math.ceil(lanes.length / layout.columns))}, minmax(0, ${tall ? `${TALL_LANE_MAX_EM}em` : '1fr'}))`,
          ...(scale !== 1 && { fontSize: `${scale}em` }),
        }}
        className={cn(
          'grid min-h-0 flex-1 grid-flow-col',
          // Capped lanes, the race centred: no lane balloons around its content.
          tall && 'content-center',
          COLUMN_CLASS[layout.columns],
          compact ? 'gap-x-[0.8em] gap-y-[0.3em]' : 'gap-y-[0.5em]',
        )}
      >
        {lanes.map((lane) => (
          <LaneRow
            key={lane.id}
            lane={lane}
            ownMs={show ? ownTimeOf(lane, show, now) : null}
            compact={compact}
            dense={layout.columns > 2}
            tall={tall}
            motion={motion}
          />
        ))}
      </ol>
      {rest.length > 0 && <Rest rest={rest} />}
    </div>
  );
}

/** The meta column's width: the same in every lane, so the stages line up across lanes. */
const metaWidth = (compact: boolean, dense: boolean, tall: boolean) =>
  // Tall lanes line their stages up on a row of their own: the meta takes what it needs.
  tall ? 'w-auto' : dense ? 'w-[7em]' : compact ? 'w-[10em]' : 'w-[14em]';

function LaneRow({
  lane,
  ownMs,
  compact,
  dense,
  tall,
  motion,
}: {
  lane: Lane;
  ownMs: number | null;
  compact: boolean;
  /** Three or four columns: the name and the stages first, the hint count left out. */
  dense: boolean;
  /** A small race: the place, name and meta on a line, the stages full width under it. */
  tall: boolean;
  motion: MotionLevel;
}) {
  const { t } = useTranslation('escape');
  const out = lane.timedOut && !lane.escaped;
  const place = (
    <span
      data-place
      className="bg-primary text-primary-foreground flex min-w-[2.4em] shrink-0 justify-center rounded-full px-[0.3em] text-[1.1em] font-bold tabular-nums"
    >
      <span className="sr-only">{t('screen.track.placeLabel', { place: lane.place })}</span>
      <span aria-hidden="true">{t('screen.track.place', { place: lane.place })}</span>
    </span>
  );
  const title = !compact && !lane.escaped && !out && lane.stageTitle && (
    <span className="truncate text-[0.9em] font-medium">{lane.stageTitle}</span>
  );
  const name = (
    <span
      data-lane-name
      // Tall: the name before the stage title, which gives way first.
      className={cn('truncate text-[1.4em] leading-tight font-bold', tall && 'max-w-full shrink-0')}
    >
      {lane.name}
    </span>
  );
  const meta = (
    <div
      data-lane-meta
      className={cn(
        'flex shrink-0 items-center justify-end gap-[0.6em] overflow-hidden text-[1em] font-semibold tabular-nums',
        metaWidth(compact, dense, tall),
      )}
    >
      {lane.connectedCount === 0 && !lane.escaped && (
        <span className="flex shrink-0 items-center gap-[0.2em]">
          <WifiOff aria-hidden className="size-[1em]" />
          {t('lobby.offline')}
        </span>
      )}
      {lane.hintsUsed > 0 && !dense && (
        <span className="flex shrink-0 items-center gap-[0.2em]">
          <Lightbulb aria-hidden className="size-[1em]" />
          {t('screen.track.hints', { count: lane.hintsUsed })}
        </span>
      )}
      {lane.escaped ? (
        <span className="flex shrink-0 items-center gap-[0.2em] text-[1.1em] font-bold">
          <CircleCheck aria-hidden className="size-[1.1em]" />
          {t('screen.track.escaped', { time: formatClock(lane.escapedAtMs ?? 0) })}
        </span>
      ) : out ? (
        <span className="flex shrink-0 items-center gap-[0.2em] font-bold">
          <Hourglass aria-hidden className="size-[1em]" />
          {t('screen.track.timeUp')}
        </span>
      ) : ownMs !== null ? (
        <span className="shrink-0 font-mono">{formatClock(ownMs)}</span>
      ) : null}
    </div>
  );
  return (
    <li
      data-lane={lane.id}
      data-out={out || undefined}
      data-stacked={tall || undefined}
      className={cn(
        'bg-card text-card-foreground flex min-h-0 min-w-0 overflow-hidden rounded-[0.5em] border-[0.1em]',
        tall
          ? 'flex-col justify-center gap-[0.5em] px-[0.8em] py-[0.5em]'
          : cn('items-center', dense ? 'gap-[0.4em] px-[0.3em]' : 'gap-[0.8em] px-[0.6em]'),
        // Greyed, never faded: faded text would fall under 7:1. "Time up" says it too.
        out && 'border-dashed grayscale',
        lane.escaped && 'border-primary',
      )}
    >
      {tall ? (
        <>
          <div className="flex min-w-0 items-center gap-[0.8em]">
            {place}
            <div className="flex min-w-0 flex-1 items-baseline gap-[0.8em]">
              {name}
              {title}
            </div>
            {meta}
          </div>
          <Segments lane={lane} motion={motion} tall />
        </>
      ) : (
        <>
          {place}
          <div
            className={cn(
              'flex min-w-0 flex-col',
              dense ? 'w-[5em] shrink' : compact ? 'w-[8em] shrink-0' : 'w-[12em] shrink-0',
            )}
          >
            {name}
            {title}
          </div>
          <Segments lane={lane} motion={motion} />
          {meta}
        </>
      )}
    </li>
  );
}

function Segments({
  lane,
  motion,
  tall = false,
}: {
  lane: Lane;
  motion: MotionLevel;
  tall?: boolean;
}) {
  const { t } = useTranslation('escape');
  const stages = Array.from({ length: lane.stageCount }, (_, i) => i);
  return (
    <div
      role="img"
      aria-label={t('screen.track.stageOf', {
        stage: Math.min(lane.stageIndex + 1, lane.stageCount),
        count: lane.stageCount,
      })}
      className={cn('flex min-w-0 gap-[0.25em]', tall ? 'h-[2.2em] shrink-0' : 'h-[1.6em] flex-1')}
    >
      {stages.map((i) => {
        const state =
          lane.escaped || i < lane.stageIndex
            ? 'done'
            : i === lane.stageIndex
              ? 'current'
              : 'ahead';
        const share =
          state === 'done'
            ? 1
            : state === 'current' && lane.locksTotal > 0
              ? lane.locksSolved / lane.locksTotal
              : 0;
        return (
          <div
            key={i}
            data-testid="stage-segment"
            data-state={state}
            className={cn(
              // Edged: a stage ahead stands out from the lane at 3:1 (screen-palette.ts).
              'bg-muted relative flex flex-1 items-center justify-center overflow-hidden rounded-[0.3em] border-[0.08em]',
              state === 'current' && 'ring-primary ring-[0.12em]',
            )}
          >
            <div
              data-testid="stage-fill"
              aria-hidden
              style={{ width: `${share * 100}%` }}
              className={cn(
                'bg-primary absolute inset-y-0 left-0',
                motion === 'full' && 'transition-[width] duration-700 ease-out',
              )}
            />
            {state === 'current' && lane.locksTotal > 0 && (
              // Over a fill that only moves on a solve, and on a plate so it reads on both.
              <span
                aria-hidden
                className="bg-card relative rounded-[0.2em] px-[0.25em] text-[0.9em] leading-none font-bold tabular-nums"
              >
                {lane.locksSolved}/{lane.locksTotal}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Above 30 teams: how many more, and how many of them stand at each stage. */
function Rest({ rest }: { rest: Lane[] }) {
  const { t } = useTranslation('escape');
  const escaped = rest.filter((l) => l.escaped).length;
  const byStage = new Map<number, number>();
  for (const l of rest)
    if (!l.escaped) byStage.set(l.stageIndex, (byStage.get(l.stageIndex) ?? 0) + 1);
  return (
    <p className="flex flex-wrap items-baseline gap-x-[1.2em] text-[1.1em] font-semibold">
      <span>{t('screen.track.more', { count: rest.length })}</span>
      {[...byStage.entries()]
        .sort(([a], [b]) => b - a)
        .map(([stage, count]) => (
          <span key={stage} className="tabular-nums">
            {t('screen.track.atStage', { stage: stage + 1, count })}
          </span>
        ))}
      {escaped > 0 && (
        <span className="tabular-nums">{t('screen.track.escapedCount', { count: escaped })}</span>
      )}
    </p>
  );
}
