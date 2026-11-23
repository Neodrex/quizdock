import type { EscapeHostOutline, EscapeHostState, EscapeHostTeam } from '@quiz-dock/contracts';
import { Check, Pause, WifiOff } from 'lucide-react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Segmented } from '@/components/ui/segmented';
import { useMediaQuery } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';
import { formatDelta } from '../escape-reducer';
import { formatClock } from '../team-timer';
import { GiveHintButton, type HostCommands } from './host-actions';
import { timeOnStageAt } from './host-reducer';
import type { TeamSearch } from './team-search';
import { useNow } from '../use-now';

/**
 * The live dashboard while the run is on (M5 Task 5.11): every team's stages, locks,
 * wrong tries, hints and time left, on one server-time tick (§1.7). Rows on a laptop
 * (`lg`), cards in two columns on a tablet. A team picked here shows in the detail;
 * the pick is kept in the URL (`?team=`), so a reload keeps it.
 */

export type GridSort = 'progress' | 'name';
const SORT_KEY = 'live.escape.host.sort';
/** The laptop layout (rows); below it, cards. */
export const LAPTOP = '(min-width: 1024px)';

/** Time left at `now`: counted to the deadline, or as sent while there is none (paused). */
export function timeLeftOf(
  team: Pick<EscapeHostTeam, 'deadlineAt' | 'remainingMs'>,
  now: number,
): number {
  return team.deadlineAt === null
    ? Math.max(0, team.remainingMs)
    : Math.max(0, team.deadlineAt - now);
}

/** How far a team is: an escaped team is past its last stage. */
const reach = (t: EscapeHostTeam) => (t.escaped ? t.stageCount : t.stageIndex);

/** Leaders first: by stage, then locks solved, then time left; or by name. */
export function sortTeams(teams: EscapeHostTeam[], by: GridSort, now: number): EscapeHostTeam[] {
  const byName = (a: EscapeHostTeam, b: EscapeHostTeam) => a.name.localeCompare(b.name);
  return [...teams].sort((a, b) =>
    by === 'name'
      ? byName(a, b)
      : reach(b) - reach(a) ||
        b.locksSolved - a.locksSolved ||
        timeLeftOf(b, now) - timeLeftOf(a, now) ||
        byName(a, b),
  );
}

function loadSort(): GridSort {
  try {
    return localStorage.getItem(SORT_KEY) === 'name' ? 'name' : 'progress';
  } catch {
    return 'progress';
  }
}

function saveSort(by: GridSort) {
  try {
    localStorage.setItem(SORT_KEY, by);
  } catch {
    // Nothing to keep it in (a private window): it lasts this page only.
  }
}

/**
 * The team picked in the grid, kept in the URL's `?team=` (the control route's
 * `validateTeamSearch`) so a reload keeps it. A pick replaces the history entry.
 */
export function useTeamSelection(): [string | null, (id: string | null) => void] {
  const { team } = useSearch({ strict: false }) as TeamSearch;
  const navigate = useNavigate();
  const select = useCallback(
    (id: string | null) =>
      void navigate({
        to: '.',
        search: (prev: Record<string, unknown>) => ({ ...prev, team: id ?? undefined }),
        replace: true,
      }),
    [navigate],
  );
  return [team ?? null, select];
}

/** What one stage of a team shows: done (with its split), current (locks), or ahead. */
function StageCell({ team, index }: { team: EscapeHostTeam; index: number }) {
  const { t } = useTranslation('escape');
  if (index < reach(team)) {
    const split = (team.stageClearedAt[index] ?? 0) - (team.stageClearedAt[index - 1] ?? 0);
    const time = formatClock(split);
    return (
      <span className="text-success-text flex items-center gap-1 tabular-nums">
        <Check className="size-4" aria-hidden />
        <span aria-hidden>{time}</span>
        <span className="sr-only">{t('host.grid.done', { time })}</span>
      </span>
    );
  }
  if (index === team.stageIndex) {
    return (
      <span className="font-medium tabular-nums">
        {t('host.grid.current', { solved: team.locksSolved, total: team.locksTotal })}
      </span>
    );
  }
  return (
    <span className="text-muted-foreground">
      <span aria-hidden>—</span>
      <span className="sr-only">{t('host.grid.ahead')}</span>
    </span>
  );
}

function Connected({ team }: { team: EscapeHostTeam }) {
  const { t } = useTranslation('escape');
  const offline = team.connectedCount < team.memberCount;
  return (
    <span
      className={cn('flex items-center gap-1 text-sm tabular-nums', offline && 'text-warning-text')}
      aria-label={t('host.board.ready', {
        connected: team.connectedCount,
        total: team.memberCount,
      })}
    >
      {offline ? <WifiOff className="size-3.5" aria-hidden /> : null}
      <span aria-hidden>
        {team.connectedCount}/{team.memberCount}
      </span>
    </span>
  );
}

const hintsOf = (team: EscapeHostTeam) =>
  team.hintPenaltyS > 0
    ? `${team.hintsUsed} · ${formatDelta(team.hintPenaltyS * 1000)}`
    : String(team.hintsUsed);

/** Playing, escaped (in its run time), timed out, or stuck (with a quick hint). */
function Status({
  outline,
  team,
  onStageMs,
  commands,
}: {
  outline: EscapeHostOutline;
  team: EscapeHostTeam;
  /** Its time on the stage now (`timeOnStageAt`). */
  onStageMs: number;
  commands: Pick<HostCommands, 'hint' | 'pending' | 'tools'>;
}) {
  const { t } = useTranslation('escape');
  if (team.escaped) {
    return (
      <Badge variant="success">
        {t('host.grid.escaped', { time: formatClock(team.stageClearedAt.at(-1) ?? 0) })}
      </Badge>
    );
  }
  if (team.timedOut) return <Badge variant="destructive">{t('host.grid.timedOut')}</Badge>;
  if (team.stuck) {
    return (
      // The quick hint is its own control: a tap on it does not pick the team.
      <div className="flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <Badge variant="warning">
          {t('host.grid.stuck', { minutes: Math.floor(onStageMs / 60_000) })}
        </Badge>
        <GiveHintButton outline={outline} team={team} commands={commands} compact />
      </div>
    );
  }
  return <span className="text-muted-foreground text-sm">{t('host.grid.playing')}</span>;
}

function TeamName({
  team,
  selected,
  onSelect,
  className,
}: {
  team: EscapeHostTeam;
  selected: boolean;
  onSelect: (id: string) => void;
  className?: string;
}) {
  const { t } = useTranslation('escape');
  return (
    <button
      type="button"
      data-team-card={team.id}
      aria-pressed={selected}
      aria-label={t('host.grid.show', { team: team.name })}
      className={cn(
        'flex min-h-11 min-w-0 items-center gap-2 rounded-md text-left font-semibold',
        className,
      )}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(team.id);
      }}
    >
      <span className="truncate">{team.name}</span>
    </button>
  );
}

export function RunGrid({
  outline,
  host,
  selected,
  onSelect,
  commands,
  heardAt,
}: {
  outline: EscapeHostOutline;
  host: EscapeHostState;
  selected: string | null;
  onSelect: (teamId: string) => void;
  commands: Pick<HostCommands, 'hint' | 'pending' | 'tools'>;
  /** When each team's payload came (`EscapeHostUi.heardAt`): its time on stage runs on. */
  heardAt?: Record<string, number>;
}) {
  const { t } = useTranslation('escape');
  const now = useNow(1000);
  const laptop = useMediaQuery(LAPTOP);
  const [sort, setSort] = useState<GridSort>(loadSort);
  const teams = sortTeams(host.teams, sort, now);
  const paused = host.board.clock.paused;
  const stages = outline.stages;
  const onStage = (team: EscapeHostTeam) => timeOnStageAt(team, heardAt, host.board.clock, now);

  return (
    <section aria-labelledby="escape-grid" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="escape-grid" className="text-lg font-semibold">
          {t('host.grid.title')}
        </h2>
        <Segmented<GridSort>
          label={t('host.grid.sort')}
          value={sort}
          onChange={(v) => {
            setSort(v);
            saveSort(v);
          }}
          options={[
            { value: 'progress', label: t('host.grid.byProgress') },
            { value: 'name', label: t('host.grid.byName') },
          ]}
        />
      </div>
      {paused ? (
        <p
          role="status"
          className="bg-warning/15 text-warning-text flex items-center gap-2 rounded-md px-3 py-2 font-medium"
        >
          <Pause className="size-4" aria-hidden />
          {t('host.grid.paused')}
        </p>
      ) : null}
      {teams.length === 0 ? (
        <p className="text-muted-foreground">{t('host.grid.none')}</p>
      ) : laptop ? (
        // A wide grid scrolls in its own box, never the page.
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('host.grid.title')}</caption>
            <thead className="bg-muted/50 text-left">
              <tr>
                <th scope="col" className="px-3 py-2">
                  {t('host.grid.team')}
                </th>
                {stages.map((s, i) => (
                  <th
                    key={s.id}
                    scope="col"
                    className="px-3 py-2 whitespace-nowrap"
                    title={s.title}
                  >
                    {t('host.grid.stage', { n: i + 1 })}
                  </th>
                ))}
                <th scope="col" className="px-3 py-2">
                  {t('host.grid.wrong')}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t('host.grid.hints')}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t('host.grid.left')}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t('host.grid.status')}
                </th>
              </tr>
            </thead>
            <tbody>
              {teams.map((team) => (
                <tr
                  key={team.id}
                  data-team={team.id}
                  data-selected={selected === team.id || undefined}
                  className={cn(
                    'hover:bg-accent/50 cursor-pointer border-t',
                    selected === team.id && 'bg-accent',
                  )}
                  onClick={() => onSelect(team.id)}
                >
                  <th scope="row" className="px-3 py-1 text-left font-normal">
                    <div className="flex items-center gap-3">
                      <TeamName team={team} selected={selected === team.id} onSelect={onSelect} />
                      <Connected team={team} />
                    </div>
                  </th>
                  {stages.map((s, i) => (
                    <td key={s.id} className="px-3 py-1">
                      <StageCell team={team} index={i} />
                    </td>
                  ))}
                  <td className="px-3 py-1 tabular-nums">{team.wrong}</td>
                  <td className="px-3 py-1 whitespace-nowrap tabular-nums">{hintsOf(team)}</td>
                  <td className="px-3 py-1 font-mono tabular-nums">
                    {formatClock(timeLeftOf(team, now))}
                  </td>
                  <td className="px-3 py-1">
                    <Status
                      outline={outline}
                      team={team}
                      onStageMs={onStage(team)}
                      commands={commands}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {teams.map((team) => (
            <li key={team.id} className="flex">
              <article
                data-team={team.id}
                aria-label={team.name}
                className={cn(
                  'bg-card flex w-full cursor-pointer flex-col gap-2 rounded-lg border p-3',
                  selected === team.id && 'ring-primary ring-2',
                )}
                onClick={() => onSelect(team.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <TeamName
                    team={team}
                    selected={selected === team.id}
                    onSelect={onSelect}
                    className="flex-1"
                  />
                  <Connected team={team} />
                </div>
                <ol className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
                  {stages.map((s, i) => (
                    <li key={s.id} className="flex items-center gap-1">
                      <span className="text-muted-foreground">{i + 1}.</span>
                      <StageCell team={team} index={i} />
                    </li>
                  ))}
                </ol>
                <dl className="grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <dt className="text-muted-foreground text-xs">{t('host.grid.wrong')}</dt>
                    <dd className="tabular-nums">{team.wrong}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-xs">{t('host.grid.hints')}</dt>
                    <dd className="tabular-nums">{hintsOf(team)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-xs">{t('host.grid.left')}</dt>
                    <dd className="font-mono tabular-nums">{formatClock(timeLeftOf(team, now))}</dd>
                  </div>
                </dl>
                <Status
                  outline={outline}
                  team={team}
                  onStageMs={onStage(team)}
                  commands={commands}
                />
              </article>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
