import type { EscapeClock } from '@quiz-dock/contracts';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { drawEn, en, GAME } from '../test-fixtures';
import { ActivityFeed, ConsoleAnnouncer, feedKey, loadFeed, saveFeed } from './activity-feed';
import { FEED_KEPT, type FeedLine } from './host-reducer';

const NOW = 1_000_000_000;
vi.mock('../../clock', () => ({ serverNow: () => NOW }));

const clock: EscapeClock = {
  serverNow: NOW,
  paused: false,
  elapsedMs: 800_000,
  limitMs: 2_400_000,
};
const teams = [
  { id: 't1', name: 'Team Red' },
  { id: 't2', name: 'Team Blue' },
];

const line = (id: number, over: Partial<FeedLine> = {}): FeedLine => ({
  id,
  key: 'host.feed.stageCleared',
  params: { team: 'Team Red', stage: 'The Lobby' },
  teamId: 't1',
  atMs: id * 60_000,
  ...over,
});

const red = line(1, { atMs: 760_000 });
const blue = line(2, {
  key: 'host.feed.timeUp',
  params: { team: 'Team Blue' },
  teamId: 't2',
  atMs: 770_000,
});

function draw(feed: FeedLine[], selectedTeam: string | null = null, gameId: string | null = GAME) {
  return drawEn(
    <ActivityFeed
      gameId={gameId}
      feed={feed}
      clock={clock}
      teams={teams}
      selectedTeam={selectedTeam}
    />,
  );
}

const list = () => screen.getByRole('list', { name: 'Activity, newest first' });
const items = () => within(list()).getAllByRole('listitem');

describe('ActivityFeed', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('newest first, each line with its run time and its team', () => {
    draw([red, blue]);
    const [first, second] = items();
    expect(first).toHaveTextContent('12:50');
    expect(first).toHaveTextContent('Team Blue: time is up');
    expect(second).toHaveTextContent('12:40');
    expect(second).toHaveTextContent('Team Red cleared The Lobby');
  });

  it('an empty feed says so', () => {
    draw([]);
    expect(screen.getByText('Nothing has happened yet.')).toBeInTheDocument();
  });

  it('is a labelled <ol>, not a live region; the announcer speaks the polite queue', () => {
    draw([red]);
    expect(list().tagName).toBe('OL');
    expect(list().closest('[aria-live]')).toBeNull();
    vi.useFakeTimers();
    try {
      drawEn(
        <ConsoleAnnouncer
          polite={[
            { id: 1, key: 'host.feed.escaped', params: { team: 'Team Red', time: '31:12' } },
          ]}
        />,
      );
      act(() => vi.advanceTimersByTime(0));
      expect(screen.getByRole('status')).toHaveTextContent('Team Red escaped in 31:12');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the last lines in sessionStorage per game', () => {
    const many = Array.from({ length: FEED_KEPT + 5 }, (_, i) => line(i + 1));
    draw(many);
    const kept = loadFeed(GAME);
    expect(kept).toHaveLength(FEED_KEPT);
    expect(kept.at(-1)?.id).toBe(FEED_KEPT + 5);
    expect(sessionStorage.getItem(feedKey('other'))).toBeNull();
  });

  it('a reload shows the kept lines, then a "Reconnected" line, then the new ones', () => {
    const first = draw([red, blue]);
    first.unmount();
    // The new page load: its reducer starts over (ids from 1 again).
    draw([line(1, { key: 'host.feed.roles', params: { team: 'Team Red' }, atMs: 820_000 })]);
    const texts = items().map((li) => li.textContent);
    expect(texts).toEqual([
      expect.stringContaining('Team Red: roles dealt again'),
      expect.stringMatching(/^13:20.*Reconnected$/),
      expect.stringContaining('Team Blue: time is up'),
      expect.stringContaining('Team Red cleared The Lobby'),
    ]);
    // And they are kept for the next reload, the marker with them.
    expect(loadFeed(GAME).map((l) => l.key)).toEqual([
      'host.feed.stageCleared',
      'host.feed.timeUp',
      'host.feed.reconnected',
      'host.feed.roles',
    ]);
  });

  it('a fresh run (nothing kept) has no "Reconnected" line', () => {
    draw([red]);
    expect(screen.queryByText('Reconnected')).toBeNull();
  });

  it('kept lines that are not feed lines are dropped; a blocked storage keeps the feed on screen', () => {
    sessionStorage.setItem(
      feedKey(GAME),
      JSON.stringify([{ uid: 'x', key: 'evil', atMs: 0, teamId: null }, 'junk']),
    );
    expect(loadFeed(GAME)).toEqual([]);
    sessionStorage.setItem(feedKey(GAME), '{not json');
    expect(loadFeed(GAME)).toEqual([]);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => saveFeed(GAME, [])).not.toThrow();
    sessionStorage.clear();
    draw([red]);
    expect(items()).toHaveLength(1);
  });

  it('the filter: all teams or one; it follows the selected team', () => {
    const { rerender } = draw([red, blue]);
    const filter = screen.getByLabelText('Show');
    expect(filter).toHaveValue('');
    expect(items()).toHaveLength(2);
    fireEvent.change(filter, { target: { value: 't2' } });
    expect(items()).toHaveLength(1);
    expect(items()[0]).toHaveTextContent('Team Blue');
    rerender(
      <I18nextProvider i18n={en}>
        <ActivityFeed
          gameId={GAME}
          feed={[red, blue]}
          clock={clock}
          teams={teams}
          selectedTeam="t1"
        />
      </I18nextProvider>,
    );
    expect(screen.getByLabelText('Show')).toHaveValue('t1');
    expect(items()).toHaveLength(1);
    expect(items()[0]).toHaveTextContent('Team Red');
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: '' } });
    expect(items()).toHaveLength(2);
  });
});
