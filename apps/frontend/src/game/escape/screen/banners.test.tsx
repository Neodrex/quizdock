import { act, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MotionLevel } from '../../motion/level';
import { SAY_MS } from '../escape-announcer';
import { drawEn, en } from '../test-fixtures';
import { ScreenBanners } from './banners';
import {
  type EscapeScreenAction,
  type EscapeScreenUi,
  initialScreenUi,
  screenReducer,
} from './screen-reducer';
import { announceOf, boardOf, summaryOf } from './screen-fixtures';

const motion = vi.hoisted(() => ({ level: 'full' as MotionLevel }));
vi.mock('../../motion/level', () => ({ useMotionLevel: () => motion.level }));

const NOW = 1_000_000_000;

const run = (actions: EscapeScreenAction[], from: EscapeScreenUi = initialScreenUi) =>
  actions.reduce(screenReducer, from);
const shown = (over: Parameters<typeof announceOf>[0], from?: EscapeScreenUi) =>
  run([{ type: 'announce', announce: announceOf(over), now: NOW }], from);

const el = (ui: EscapeScreenUi) => <ScreenBanners ui={ui} />;
const wrap = (node: ReactNode) => <I18nextProvider i18n={en}>{node}</I18nextProvider>;

beforeEach(() => {
  motion.level = 'full';
});

describe('ScreenBanners', () => {
  it.each([
    [{ kind: 'stage-cleared', stageIndex: 1 }, 'Team Red cleared stage 2'],
    [{ kind: 'escaped', stageIndex: 2 }, 'Team Red escaped!'],
    [{ kind: 'hint' }, 'Team Red took a hint'],
    [{ kind: 'time-up' }, 'Time is up for Team Red'],
  ] as const)('shows %o as "%s"', (over, text) => {
    drawEn(el(shown(over)));
    expect(screen.getByTestId('screen-banner')).toHaveTextContent(text);
  });

  it('names the stage cleared by its title once a team reached it', () => {
    const ui = run([
      {
        type: 'board',
        board: boardOf({ teams: [summaryOf({ stageIndex: 1, stageTitle: 'The Office' })] }),
      },
      { type: 'announce', announce: announceOf({ stageIndex: 1 }), now: NOW },
    ]);
    drawEn(el(ui));
    expect(screen.getByTestId('screen-banner')).toHaveTextContent(
      'Team Red cleared stage 2: The Office',
    );
  });

  it('shows one banner at a time, the next once the reducer moves on', () => {
    const first = run([
      { type: 'announce', announce: announceOf({ kind: 'stage-cleared' }), now: NOW },
      {
        type: 'announce',
        announce: announceOf({ kind: 'hint', teamId: 't2', teamName: 'Team Blue' }),
        now: NOW,
      },
    ]);
    const { rerender } = drawEn(el(first));
    expect(screen.getAllByTestId('screen-banner')).toHaveLength(1);
    expect(screen.getByTestId('screen-banner')).toHaveTextContent('Team Red cleared stage 1');
    rerender(wrap(el(screenReducer(first, { type: 'next', now: NOW + 10_000 }))));
    expect(screen.getByTestId('screen-banner')).toHaveTextContent('Team Blue took a hint');
  });

  it('says each banner once, politely', () => {
    vi.useFakeTimers();
    try {
      const ui = shown({ kind: 'escaped' });
      const { rerender } = drawEn(el(ui));
      const status = screen.getByRole('status');
      expect(status).toHaveAttribute('aria-live', 'polite');
      expect(status).toHaveTextContent('Team Red escaped!');
      act(() => vi.advanceTimersByTime(SAY_MS + 10));
      expect(status).toHaveTextContent('');
      rerender(wrap(el({ ...ui })));
      act(() => vi.advanceTimersByTime(10));
      expect(status).toHaveTextContent('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives an escape the larger style', () => {
    const { unmount } = drawEn(el(shown({ kind: 'escaped' })));
    expect(screen.getByTestId('screen-banner')).toHaveAttribute('data-size', 'large');
    unmount();
    drawEn(el(shown({ kind: 'hint' })));
    expect(screen.getByTestId('screen-banner')).not.toHaveAttribute('data-size', 'large');
  });

  it('sits in its own layout slot, never over the show clock', () => {
    drawEn(el(shown({ kind: 'hint' })));
    const slot = screen.getByTestId('banner-slot');
    expect(slot.className).not.toMatch(/\b(absolute|fixed)\b/);
    expect(screen.getByTestId('screen-banner').className).not.toMatch(/\b(absolute|fixed)\b/);
    // The slot keeps its height when empty: nothing below jumps.
    const { container } = drawEn(el(initialScreenUi));
    expect(container.querySelector('[data-testid="banner-slot"]')?.className).toMatch(/min-h-/);
  });

  it('while paused, shows nothing and keeps the banner waiting', () => {
    const paused = boardOf({ clock: { ...boardOf().clock, paused: true } });
    const ui = run([
      { type: 'board', board: paused },
      { type: 'announce', announce: announceOf({ kind: 'hint' }), now: NOW },
    ]);
    drawEn(el(ui));
    expect(screen.queryByTestId('screen-banner')).toBeNull();
    expect(ui.banners).toHaveLength(1);
  });

  it.each(['full', 'fade', 'none'] as const)('follows the motion level (%s)', (level) => {
    motion.level = level;
    drawEn(el(shown({ kind: 'hint' })));
    expect(screen.getByTestId('screen-banner')).toHaveAttribute('data-motion', level);
  });
});
