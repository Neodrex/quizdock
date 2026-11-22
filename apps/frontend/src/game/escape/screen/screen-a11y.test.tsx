import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MotionLevel } from '../../motion/level';
import { drawEn } from '../test-fixtures';
import { ScreenBanners } from './banners';
import { RaceTrack } from './race-track';
import { REPLAY_MS } from './replay-timeline';
import { announceOf, boardOf, screenFinaleOf, summaryOf } from './screen-fixtures';
import { ScreenFinale } from './screen-finale';
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
});

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
  const src = resolve(process.cwd(), 'src');
  const dir = resolve(src, 'game/escape/screen');
  const files = [
    ...readdirSync(dir)
      .filter((n) => /\.tsx?$/.test(n) && !/\.test\.tsx?$|-fixtures\.tsx?$/.test(n))
      .map((n) => join(dir, n)),
    resolve(src, 'routes/escape-screen-page.tsx'),
  ];
  // Tailwind's opacity steps and colour alphas (`text-foreground/60`); 0 and 100 are
  // not a fade. Motion's fade-ins are transitions, not a resting state.
  const FADED = /\bopacity-(?!0\b|100\b)\d+|\b(text|bg)-[a-z-]+\/\d+/;

  it('catches a faded class', () => {
    expect(FADED.test("'opacity-60 grayscale'")).toBe(true);
    expect(FADED.test('text-foreground/70')).toBe(true);
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
    expect(screen.getByTestId('show-clock-digits').className).toContain('animate-');
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

  it('the finale: podium steps share the width (4:3), four more listed, the rest counted', () => {
    const r = screenFinaleOf().ranking[0];
    const finale = screenFinaleOf({
      ranking: Array.from({ length: 12 }, (_, i) => ({
        ...r,
        teamId: `t${i + 1}`,
        name: `Team ${i + 1}`,
        place: i + 1,
      })),
    });
    drawEn(<ScreenFinale finale={finale} replay="done" closed onReplayDone={() => undefined} />);
    for (const step of screen.getAllByTestId('podium-step')) {
      expect(step).toHaveClass('flex-1', 'max-w-[18em]');
      expect(step.className).not.toMatch(/(^|\s)w-\[/);
    }
    expect(screen.getAllByTestId('ranked-row')).toHaveLength(4);
    expect(screen.getByTestId('ranked-list')).toHaveClass('grid-cols-2');
    expect(screen.getByText('and 5 more teams')).toBeInTheDocument();
    // Closed: the thanks take the closing text's line.
    expect(screen.getByText('Thanks for playing')).toBeInTheDocument();
    expect(screen.queryByText('The vault is open.')).toBeNull();
  });
});
