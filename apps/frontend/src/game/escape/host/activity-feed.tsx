import type { EscapeClock, EscapeHostTeam } from '@quiz-dock/contracts';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/select';
import { serverNow } from '../../clock';
import type { Announcement } from '../escape-reducer';
import { EscapeAnnouncer } from '../escape-announcer';
import { formatClock } from '../team-timer';
import { FEED_KEPT, type FeedLine, runMsAt } from './host-reducer';

/**
 * What happened in the run, newest first (M5 Task 5.14): each line with its run time
 * and its team. The lines are kept in `sessionStorage` per game (the last FEED_KEPT),
 * so a reload shows them again after a "Reconnected" line (§1.5). The list is not a
 * live region: the console announcer speaks the reducer's polite queue instead.
 */

/** A line as kept: `uid` tells lines of different page loads apart (their ids restart). */
export interface KeptLine extends FeedLine {
  uid: string;
}

export const feedKey = (gameId: string) => `live.escape.host.feed.${gameId}`;

const isLine = (v: unknown): v is KeptLine => {
  const l = v as Partial<KeptLine> | null;
  return (
    !!l &&
    typeof l.uid === 'string' &&
    typeof l.key === 'string' &&
    l.key.startsWith('host.feed.') &&
    typeof l.atMs === 'number' &&
    (l.teamId === null || typeof l.teamId === 'string')
  );
};

/** The lines kept for this game, oldest first; none when absent or unreadable. */
export function loadFeed(gameId: string): KeptLine[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(feedKey(gameId)) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter(isLine).slice(-FEED_KEPT) : [];
  } catch {
    return [];
  }
}

export function saveFeed(gameId: string, lines: KeptLine[]): void {
  try {
    sessionStorage.setItem(feedKey(gameId), JSON.stringify(lines.slice(-FEED_KEPT)));
  } catch {
    // Nothing to keep it in (a private window, a full quota): this page load only.
  }
}

/**
 * The feed to show for `gameId`: the lines kept from an earlier load of the page,
 * a "Reconnected" line if there were any, then this load's lines. Saved on change.
 */
export function useKeptFeed(
  gameId: string | null,
  live: FeedLine[],
  clock: EscapeClock | undefined,
): KeptLine[] {
  // This page load: its lines' uids differ from the kept ones'.
  const loadRef = useRef(`${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  const [earlier, setEarlier] = useState<{ gameId: string | null; lines: KeptLine[] }>(() => ({
    gameId,
    lines: gameId ? withReconnect(loadFeed(gameId), clock, loadRef.current) : [],
  }));
  // Another run in the room: its own kept lines (none on a fresh run).
  let kept = earlier;
  if (earlier.gameId !== gameId) {
    kept = {
      gameId,
      lines: gameId ? withReconnect(loadFeed(gameId), clock, loadRef.current) : [],
    };
    setEarlier(kept);
  }
  const lines = [
    ...kept.lines,
    ...live.map((l) => ({ ...l, uid: `${loadRef.current}-${l.id}` })),
  ].slice(-FEED_KEPT);
  const last = lines.at(-1)?.uid;
  useEffect(() => {
    if (gameId && lines.length) saveFeed(gameId, lines);
    // The last uid stands for the whole list: lines are only ever appended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, last, lines.length]);
  return lines;
}

function withReconnect(
  lines: KeptLine[],
  clock: EscapeClock | undefined,
  load: string,
): KeptLine[] {
  if (!lines.length) return lines;
  const atMs = clock ? runMsAt(clock, serverNow()) : (lines.at(-1)?.atMs ?? 0);
  return [
    ...lines,
    { id: 0, uid: `${load}-reconnected`, key: 'host.feed.reconnected', teamId: null, atMs },
  ];
}

/** The console's polite region: stage cleared, escaped, stuck, time up, a player gone. */
export function ConsoleAnnouncer({ polite }: { polite: Announcement[] }) {
  return <EscapeAnnouncer polite={polite} assertive={null} />;
}

export function ActivityFeed({
  gameId,
  feed,
  clock,
  teams,
  selectedTeam,
}: {
  gameId: string | null;
  /** The reducer's lines, oldest first. */
  feed: FeedLine[];
  /** The run clock: the time of a "Reconnected" line. */
  clock?: EscapeClock;
  teams: Pick<EscapeHostTeam, 'id' | 'name'>[];
  /** The team picked in the grid: the filter follows it. */
  selectedTeam: string | null;
}) {
  const { t } = useTranslation('escape');
  const lines = useKeptFeed(gameId, feed, clock);
  const [filter, setFilter] = useState<string>(selectedTeam ?? '');
  const [followed, setFollowed] = useState(selectedTeam);
  if (followed !== selectedTeam) {
    setFollowed(selectedTeam);
    setFilter(selectedTeam ?? '');
  }
  const headingId = useId();
  const filterId = useId();
  const shown = lines.filter((l) => !filter || l.teamId === filter || l.teamId === null).reverse();

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-lg font-semibold">
          {t('host.feed.title')}
        </h2>
        <div className="flex items-center gap-2">
          <label htmlFor={filterId} className="text-sm">
            {t('host.feed.filter')}
          </label>
          <Select
            id={filterId}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="min-h-11 w-auto text-base"
          >
            <option value="">{t('host.feed.allTeams')}</option>
            {teams.map((tm) => (
              <option key={tm.id} value={tm.id}>
                {tm.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {shown.length ? (
        <ol
          aria-label={t('host.feed.list')}
          className="flex max-h-96 flex-col gap-1 overflow-y-auto"
        >
          {shown.map((l) => (
            // The team's name is in each line's text.
            <li
              key={l.uid}
              data-team={l.teamId ?? undefined}
              className="flex gap-3 border-b py-1 text-sm last:border-b-0"
            >
              <time className="text-muted-foreground shrink-0 font-mono tabular-nums">
                {formatClock(l.atMs)}
              </time>
              <span className="min-w-0 flex-1 break-words">{t(l.key, l.params)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-muted-foreground text-sm">{t('host.feed.empty')}</p>
      )}
    </section>
  );
}
