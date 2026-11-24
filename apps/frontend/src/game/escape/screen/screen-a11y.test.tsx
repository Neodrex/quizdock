import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MotionLevel } from '../../motion/level';
import { drawEn } from '../test-fixtures';
import { ScreenBanners } from './banners';
import { RaceTrack } from './race-track';
import { REPLAY_MS } from './replay-timeline';
import { announceOf, boardOf, screenFinaleOf, summaryOf } from './screen-fixtures';
import { FINALE_ROWS, finaleListOf, ScreenFinale } from './screen-finale';
import {
  ALL_LANES_MAX,
  LANE_ROWS,
  TOP_LANES,
  WIDE_LANES_MAX,
  lanesLayoutOf,
} from './screen-layout';
import { ScreenLobby } from './screen-lobby';
import { initialScreenUi, screenReducer } from './screen-reducer';
import { ShowClock } from './show-clock';
import { SplitReplay } from './split-replay';

/**
 * The big screen read from the back of the room (M6 Task 6.17, §1.8). The colours are
 * checked in screen-palette.test.ts; here, what the components draw with them.
 */

const motion = vi.hoisted(() => ({ level: 'full' as MotionLevel }));
vi.mock('../../motion/level', () => ({ useMotionLevel: () => motion.level }));
vi.mock('qrcode.react', () => ({
  QRCodeSVG: (p: { className?: string }) => <svg role="img" className={p.className} />,
}));

const narrow = vi.hoisted(() => ({ on: false }));
vi.mock('@/lib/use-media-query', () => ({ useMediaQuery: () => narrow.on }));

const NOW = 1_000_000_000;
const MIN = 60_000;

const running = boardOf({
  clock: { serverNow: NOW, paused: false, elapsedMs: 0, limitMs: 45 * MIN },
  teams: [
    summaryOf({ escaped: true, escapedAtMs: 20 * MIN, remainingMs: 25 * MIN }),
    summaryOf({ id: 't2', name: 'Team Blue', timedOut: true, remainingMs: 0 }),
    summaryOf({
      id: 't3',
      name: 'Team Green',
      connectedCount: 0,
      hintsUsed: 2,
      remainingMs: 4 * MIN,
      deadlineAt: NOW + 4 * MIN,
    }),
    summaryOf({ id: 't4', name: 'Team Gold', remainingMs: 4 * MIN, deadlineAt: NOW + 4 * MIN }),
  ],
});
const lane = (id: string) => document.querySelector<HTMLElement>(`[data-lane="${id}"]`)!;
const hasIcon = (el: Element) => el.querySelector('svg') !== null;

beforeEach(() => {
  motion.level = 'full';
  narrow.on = false;
});

const src = resolve(process.cwd(), 'src');
/** Every shipped screen file, subfolders included, and the screen page. */
const screenFiles = () => [
  ...readdirSync(resolve(src, 'game/escape/screen'), { recursive: true, encoding: 'utf8' })
    .filter((n) => /\.tsx?$/.test(n) && !/\.test\.tsx?$|-fixtures\.tsx?$/.test(n))
    .map((n) => resolve(src, 'game/escape/screen', n)),
  resolve(src, 'routes/escape-screen-page.tsx'),
  // The public race board (M7) and the race countdown both draw on the screen.
  resolve(src, 'routes/escape-race-board-page.tsx'),
  resolve(src, 'game/escape/session/race-countdown.tsx'),
];

/** An element's font size in the screen's em: the product of the `text-[Nem]` above it. */
const emOf = (el: Element | null): number => {
  let size = 1;
  for (let e = el; e; e = e.parentElement) {
    const m = /(?:^|\s)text-\[([\d.]+)em\]/.exec(e.getAttribute('class') ?? '');
    if (m) size *= Number(m[1]);
  }
  return size;
};
const rankingOf = (n: number) => {
  const r = screenFinaleOf().ranking[0];
  return screenFinaleOf({
    ranking: Array.from({ length: n }, (_, i) => ({
      ...r,
      teamId: `t${i + 1}`,
      name: `Team ${i + 1}`,
      place: i + 1,
      hintPenaltyS: 60,
    })),
  });
};

describe('colour is never the only signal', () => {
  it('race lanes: escaped, time up, offline and hints each carry an icon and words', () => {
    drawEn(<RaceTrack board={running} now={NOW} />);
    const states: [string, RegExp][] = [
      ['t1', /Escaped/],
      ['t2', /Time up/],
      ['t3', /Offline/],
      ['t3', /2 hints/],
    ];
    for (const [id, words] of states) {
      const word = within(lane(id)).getByText(words);
      expect(hasIcon(word.closest('span')!)).toBe(true);
    }
    // Every lane: its name and its place in words, not only a colour.
    for (const id of ['t1', 't2', 't3', 't4']) {
      expect(lane(id).querySelector('[data-lane-name]')?.textContent).toBeTruthy();
      expect(within(lane(id)).getByText(/^Place \d+$/)).toHaveClass('sr-only');
    }
  });

  it('the clock: final minutes and paused in words, with their icon where they have one', () => {
    const { unmount } = drawEn(<ShowClock board={running} now={NOW} />);
    expect(screen.getByRole('timer')).toHaveAttribute('data-final', 'true');
    expect(screen.getByText('Final minutes')).toBeInTheDocument();
    unmount();
    drawEn(
      <ShowClock board={{ ...running, clock: { ...running.clock, paused: true } }} now={NOW} />,
    );
    expect(hasIcon(screen.getByText('Paused'))).toBe(true);
  });

  it.each(['escaped', 'stage-cleared', 'hint', 'time-up'] as const)(
    'a %s banner: an icon and its words',
    (kind) => {
      const ui = screenReducer(initialScreenUi, {
        type: 'announce',
        announce: announceOf({ kind }),
        now: NOW,
      });
      drawEn(<ScreenBanners ui={ui} />);
      const banner = screen.getByTestId('screen-banner');
      expect(hasIcon(banner)).toBe(true);
      expect(banner.textContent).toMatch(/Team Red/);
    },
  );

  it('the finale: escaped and time up in words beside their icons', () => {
    drawEn(
      <ScreenFinale
        finale={screenFinaleOf()}
        replay="done"
        closed={false}
        onReplayDone={() => undefined}
      />,
    );
    const [red, blue] = screen.getAllByTestId('podium-step');
    expect(hasIcon(within(red).getByText(/Escaped in/))).toBe(true);
    expect(hasIcon(within(blue).getByText(/Time up/))).toBe(true);
  });
});

describe('no faded text: opacity would take it under 7:1', () => {
  const files = screenFiles();
  // Tailwind's opacity steps and colour alphas (`text-foreground/60`); 0 and 100 are
  // not a fade. Tailwind's `pulse` dims to 0.5: a resting-state fade once a second.
  // Motion's fade-ins are transitions, not a resting state.
  const FADED = /\bopacity-(?!0\b|100\b)\d+|\b(text|bg)-[a-z-]+\/\d+|animate-(pulse|\[pulse)/;

  it('catches a faded class', () => {
    expect(FADED.test("'opacity-60 grayscale'")).toBe(true);
    expect(FADED.test('text-foreground/70')).toBe(true);
    expect(FADED.test("'animate-[pulse_1s_ease-in-out_infinite]'")).toBe(true);
    expect(FADED.test("'grayscale border-dashed'")).toBe(false);
  });

  it.each(files.map((p) => [p.slice(src.length + 1), p]))('%s', (_, path) => {
    expect(readFileSync(path, 'utf8')).not.toMatch(FADED);
  });
});

describe('reduced motion: nothing moves, nothing transforms', () => {
  /** An element that slides, pulses or spins, or is moved by a transform. */
  const moving = (root: Element) =>
    [root, ...root.querySelectorAll('*')].filter((el) => {
      const cls = el.getAttribute('class') ?? '';
      const style = (el as HTMLElement).style;
      return (
        /\b(transition|animate-|translate-)/.test(cls) ||
        (style?.transform && style.transform !== 'none')
      );
    });

  afterEach(() => vi.useRealTimers());

  it.each(['fade', 'none'] as const)('%s: lanes, banners, clock and replay', (level) => {
    motion.level = level;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ui = screenReducer(initialScreenUi, {
      type: 'announce',
      announce: announceOf({ kind: 'escaped' }),
      now: NOW,
    });
    const { container } = drawEn(
      <>
        <RaceTrack board={running} now={NOW} />
        <ScreenBanners ui={ui} />
        <ShowClock board={running} now={NOW} />
        <SplitReplay finale={screenFinaleOf()} onDone={() => undefined} />
        <ScreenLobby
          board={boardOf({ phase: 'forming', teams: [] })}
          pin="123456"
          view={{ joinBaseUrl: 'https://quiz.example' }}
        />
      </>,
    );
    // The replay is the stepped table, never the sliding race.
    expect(screen.queryByTestId('split-replay')).toBeNull();
    expect(screen.getByTestId('split-table')).toBeInTheDocument();
    expect(moving(container)).toEqual([]);
    vi.advanceTimersByTime(REPLAY_MS);
  });

  it('full: the lanes slide and the final-minutes clock pulses (the contrast case)', () => {
    drawEn(
      <>
        <RaceTrack board={running} now={NOW} />
        <ShowClock board={running} now={NOW} />
      </>,
    );
    expect(document.querySelector('[data-testid="stage-fill"]')?.className).toContain('transition');
    // The pulse grows the digits a little; it never fades them.
    const digits = screen.getByTestId('show-clock-digits');
    expect(digits).toHaveAttribute('data-pulse', 'scale');
    expect(digits.className).not.toMatch(/animate-|opacity/);
  });
});

describe('the layout fits 16:9, 16:10 and 4:3 without a scroll', () => {
  // Sized in em on 2.6vmin, 720p, 1080p and 4K are the same picture: only the aspect
  // ratio changes what fits. jsdom draws no layout: the em budget is checked here,
  // the pictures by the dev-stack check (Task 6.19).
  it('the race and the replay: wide lanes to 5, one-line lanes in up to 4 columns of 8', () => {
    for (let n = 1; n <= 60; n++) {
      const { columns, shown, wide } = lanesLayoutOf(n);
      const rows = Math.ceil(shown / columns);
      if (wide) expect(rows).toBeLessThanOrEqual(WIDE_LANES_MAX);
      else expect(rows).toBeLessThanOrEqual(LANE_ROWS);
      expect(shown).toBe(n > ALL_LANES_MAX ? TOP_LANES : n);
    }
    // 19.6 em under the final-minutes clock: 5 wide lanes of 3.3 em, 8 rows of 2.3 em.
    expect(WIDE_LANES_MAX * 3.3 + (WIDE_LANES_MAX - 1) * 0.5).toBeLessThanOrEqual(19.6);
    expect(LANE_ROWS * 2.3 - 0.3).toBeLessThanOrEqual(19.6);
  });

  const board12 = boardOf({
    teams: Array.from({ length: 12 }, (_, i) => summaryOf({ id: `t${i}`, name: `Team ${i}` })),
  });

  it('a race board: its 30 leaders by place fit 4 columns of 8, the rest counted', () => {
    const board = boardOf({
      session: {
        type: 'race',
        startsAt: null,
        totals: { teams: 212, players: 300, escaped: 0, playing: 212, latest: null },
      },
      teams: Array.from({ length: 30 }, (_, i) =>
        summaryOf({ id: `t${i}`, name: `Team ${i}`, locksSolved: i % 3 }),
      ),
    });
    drawEn(<RaceTrack board={board} now={NOW} mode="leaderboard" />);
    const track = screen.getByRole('list', { name: 'Race' });
    expect(track).toHaveAttribute('data-columns', '4');
    expect(within(track).getAllByRole('listitem')).toHaveLength(30);
    expect(screen.getByText('and 182 more teams')).toBeInTheDocument();
    const places = [...document.querySelectorAll('[data-place]')].map((el) =>
      Number(el.textContent?.replace(/\D+/g, ' ').trim().split(' ')[0]),
    );
    expect(places).toEqual([...places].sort((a, b) => a - b));
  });

  it('a race lobby: the countdown and the count, no team cards', () => {
    const board = boardOf({
      phase: 'forming',
      session: {
        type: 'race',
        startsAt: NOW + 5 * MIN,
        totals: { teams: 0, players: 44, escaped: 0, playing: 0, latest: null },
      },
    });
    drawEn(<ScreenLobby board={board} pin="482913" view={{ joinBaseUrl: null }} />);
    expect(screen.getByTestId('race-lobby')).toHaveTextContent('44 players in the room');
    expect(screen.queryByRole('list', { name: 'Teams' })).toBeNull();
  });

  it('12 teams race in two one-line columns', () => {
    drawEn(<RaceTrack board={board12} now={NOW} />);
    const track = screen.getByRole('list', { name: 'Race' });
    expect(track).toHaveAttribute('data-columns', '2');
  });

  it('the lobby: the QR at 34% of the height, stacked over the teams under 3:2', () => {
    drawEn(
      <ScreenLobby
        board={boardOf({ phase: 'forming', teams: [summaryOf()] })}
        pin="123456"
        view={{ joinBaseUrl: 'https://quiz.example' }}
      />,
    );
    const qr = screen.getByRole('img');
    const vh = Number(/h-\[(\d+)vh\]/.exec(qr.getAttribute('class') ?? '')?.[1]);
    expect(vh).toBeGreaterThanOrEqual(30);
    expect(screen.getByTestId('lobby-body').className).toContain(
      '[@media(max-aspect-ratio:3/2)]:flex-col',
    );
    expect(screen.getByTestId('join-panel').className).toContain(
      '[@media(max-aspect-ratio:3/2)]:flex-row',
    );
  });

  it('the finale lists every team up to about 30, beside a compact podium', () => {
    expect(finaleListOf(5, false)).toMatchObject({ side: false, listed: 2, more: 0 });
    expect(finaleListOf(7, false)).toMatchObject({ side: false, listed: 4, more: 0 });
    expect(finaleListOf(8, false)).toMatchObject({ side: true, columns: 2, listed: 5, more: 0 });
    expect(finaleListOf(31, false)).toMatchObject({ listed: 28, more: 0 });
    expect(finaleListOf(32, false)).toMatchObject({ listed: 28, more: 1 });
    // Under 3:2 one column: its rows are too wide for two.
    expect(finaleListOf(31, true)).toMatchObject({ columns: 1, listed: FINALE_ROWS, more: 14 });
    // The em budget: 14 rows of 1.84 em in the 26.25 em under the title.
    expect(FINALE_ROWS * 1.84 - 0.1).toBeLessThanOrEqual(26.25);
  });

  it('30 teams: the podium and 27 ranked rows with time, hints and penalty, none counted', () => {
    drawEn(
      <ScreenFinale finale={rankingOf(30)} replay="done" closed onReplayDone={() => undefined} />,
    );
    expect(screen.getAllByTestId('podium-step')).toHaveLength(3);
    const rows = screen.getAllByTestId('ranked-row');
    expect(rows).toHaveLength(27);
    expect(rows[26]).toHaveTextContent('Team 30');
    expect(rows[26]).toHaveTextContent('+1:00');
    expect(rows[26]).toHaveTextContent('2 hints');
    expect(screen.getByTestId('ranked-list')).toHaveAttribute('data-columns', '2');
    expect(screen.queryByText(/more teams/)).toBeNull();
    // Closed: the thanks take the closing text's line.
    expect(screen.getByText('Thanks for playing')).toBeInTheDocument();
    expect(screen.queryByText('The vault is open.')).toBeNull();
  });

  it('under 3:2: one column of ranked rows, the rest counted', () => {
    narrow.on = true;
    drawEn(
      <ScreenFinale
        finale={rankingOf(30)}
        replay="done"
        closed={false}
        onReplayDone={() => undefined}
      />,
    );
    expect(screen.getAllByTestId('ranked-row')).toHaveLength(FINALE_ROWS);
    expect(screen.getByText(`and ${27 - FINALE_ROWS} more teams`)).toBeInTheDocument();
  });

  it('a few teams: podium steps share the width (4:3), the others under them', () => {
    drawEn(
      <ScreenFinale
        finale={rankingOf(6)}
        replay="done"
        closed={false}
        onReplayDone={() => undefined}
      />,
    );
    expect(screen.getByTestId('podium')).toHaveAttribute('data-layout', 'row');
    expect(screen.getAllByTestId('ranked-row')).toHaveLength(3);
  });

  it('team names at least 1.4 em everywhere a team is named', () => {
    motion.level = 'fade';
    const { unmount } = drawEn(<SplitReplay finale={rankingOf(13)} onDone={() => undefined} />);
    for (const th of screen.getAllByRole('rowheader')) expect(emOf(th)).toBeGreaterThanOrEqual(1.4);
    unmount();
    motion.level = 'full';
    const replay = drawEn(<SplitReplay finale={rankingOf(30)} onDone={() => undefined} />);
    for (const l of screen.getAllByTestId('replay-lane'))
      expect(emOf(within(l).getByText(/^Team \d+$/))).toBeGreaterThanOrEqual(1.4);
    replay.unmount();
    const finale = drawEn(
      <ScreenFinale
        finale={rankingOf(30)}
        replay="done"
        closed={false}
        onReplayDone={() => undefined}
      />,
    );
    for (const row of [
      ...screen.getAllByTestId('ranked-row'),
      ...screen.getAllByTestId('podium-step'),
    ])
      expect(emOf(within(row).getByText(/^Team \d+$/))).toBeGreaterThanOrEqual(1.4);
    finale.unmount();
    drawEn(
      <RaceTrack
        board={boardOf({
          teams: Array.from({ length: 30 }, (_, i) =>
            summaryOf({ id: `t${i}`, name: `Team ${i}` }),
          ),
        })}
        now={NOW}
      />,
    );
    for (const n of document.querySelectorAll('[data-lane-name]'))
      expect(emOf(n)).toBeGreaterThanOrEqual(1.4);
  });

  it('the race and the replay fill their columns the same way: down, then across', () => {
    const teams = Array.from({ length: 12 }, (_, i) =>
      summaryOf({ id: `t${i}`, name: `Team ${i}` }),
    );
    const { unmount } = drawEn(<RaceTrack board={boardOf({ teams })} now={NOW} />);
    const track = screen.getByRole('list', { name: 'Race' });
    const trackFlow = [track.dataset.flow, track.style.gridTemplateRows];
    unmount();
    drawEn(<SplitReplay finale={rankingOf(12)} onDone={() => undefined} />);
    const lanes = screen.getByTestId('replay-lanes');
    expect([lanes.dataset.flow, lanes.style.gridTemplateRows]).toEqual(trackFlow);
    expect(trackFlow).toEqual(['column', 'repeat(6, minmax(0, 1fr))']);
  });
});
