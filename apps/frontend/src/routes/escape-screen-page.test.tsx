import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BUILTIN_THEME_VALUES, type EscapeBoard } from '@quiz-dock/contracts';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addClockSample, resetClock, serverNow } from '../game/clock';
import { ConnectionLost } from '../game/live-components';
import {
  announceOf,
  boardOf,
  screenFinaleOf,
  summaryOf,
} from '../game/escape/screen/screen-fixtures';
import { OWN_TOKENS } from '../game/escape/screen/screen-palette';
import { initialScreenUi, type EscapeScreenUi } from '../game/escape/screen/screen-reducer';
import type { EscapeScreenSession } from '../game/escape/screen/use-escape-screen';
import { drawEn } from '../game/escape/test-fixtures';
import { type GameView, INITIAL_VIEW } from '../game/use-game-session';
import { EscapeScreen } from './escape-screen-page';

// The sounds hook is tested on its own: here, what the page hands it.
const sounds = vi.hoisted(() => ({ calls: [] as { audible: boolean; now: number }[] }));
vi.mock('../game/escape/screen/screen-sounds', () => ({
  useEscapeScreenSounds: (_ui: unknown, _s: unknown, audible: boolean, o: { now: number }) => {
    sounds.calls.push({ audible, now: o.now });
  },
  ScreenSoundUnlock: ({ audible }: { audible: boolean }) =>
    audible ? <div data-testid="sound-unlock" /> : null,
}));

const PIN = '482913';
const MIN = 60_000;
const NOW = 1_000_000_000;

const view = (over: Partial<GameView> = {}): GameView => ({
  ...INITIAL_VIEW,
  status: 'ready',
  state: 'ESCAPE' as GameView['state'],
  roomName: 'Friday room',
  ...over,
});

/** Two teams, the run ending `left` ms after NOW; Team Blue has 2 min more (extra time). */
const running = (left = 20 * MIN, over: Partial<EscapeBoard> = {}) =>
  boardOf({
    clock: { serverNow: NOW, paused: false, elapsedMs: 0, limitMs: 45 * MIN },
    teams: [
      summaryOf({ remainingMs: left - 2 * MIN, deadlineAt: NOW + left - 2 * MIN }),
      summaryOf({ id: 't2', name: 'Team Blue', remainingMs: left, deadlineAt: NOW + left }),
    ],
    ...over,
  });

const escapeOf = (ui: Partial<EscapeScreenUi> = {}): EscapeScreenSession => ({
  active: true,
  ui: { ...initialScreenUi, ...ui },
  replayDone: vi.fn(),
});

const page = (
  ui: Partial<EscapeScreenUi>,
  over: { view?: Partial<GameView>; role?: 'lead' | 'follow' | 'preview'; sound?: boolean } = {},
) => (
  <>
    {/* As ScreenView: upstream's banner sits outside the escape screen. */}
    <ConnectionLost lost={!!over.view?.connectionLost} />
    <EscapeScreen
      pin={PIN}
      view={view(over.view)}
      escape={escapeOf(ui)}
      role={over.role ?? 'lead'}
      sound={over.sound ?? true}
    />
  </>
);
const draw = (...a: Parameters<typeof page>) => drawEn(page(...a));
const digits = () => screen.getByTestId('show-clock-digits');
const lane = (id: string) => document.querySelector<HTMLElement>(`[data-lane="${id}"]`)!;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
  });
  vi.setSystemTime(NOW);
  sounds.calls.length = 0;
});
afterEach(() => {
  resetClock();
  vi.useRealTimers();
});

describe('EscapeScreen', () => {
  it('forming: the lobby with the PIN, the QR code and the teams', () => {
    const board = boardOf({ phase: 'forming', teams: [summaryOf()] });
    draw({ board });
    const frame = document.querySelector('[data-escape-phase]')!;
    expect(frame).toHaveAttribute('data-escape-phase', 'forming');
    expect(frame.className).toContain('qd-screen');
    expect(screen.getByRole('heading', { name: 'Vault Heist' })).toBeInTheDocument();
    expect(screen.getByText('Friday room')).toBeInTheDocument();
    expect(screen.getAllByText(/482\s?913/).length).toBeGreaterThan(0);
    expect(screen.getByText('Team Red')).toBeInTheDocument();
    expect(screen.queryByRole('timer')).toBeNull();
  });

  it('running: the race track, the show clock, the banner and the PIN chip', () => {
    draw({
      board: running(),
      current: { ...announceOf(), id: 1, durationMs: 4000, until: NOW + 4000 },
    });
    expect(document.querySelector('[data-escape-phase]')).toHaveAttribute(
      'data-escape-phase',
      'running',
    );
    expect(lane('t1')).toBeInTheDocument();
    expect(lane('t2')).toBeInTheDocument();
    expect(digits()).toHaveTextContent('20:00');
    expect(screen.getByTestId('banner-slot')).toHaveTextContent('Team Red');
    expect(screen.getByTestId('screen-pin')).toHaveTextContent('482913');
  });

  it('finale: the screen finale, and its replay done reaches the hook', () => {
    const escape = escapeOf({
      board: running(0, { phase: 'finale' }),
      finale: screenFinaleOf(),
      replay: 'done',
    });
    drawEn(<EscapeScreen pin={PIN} view={view()} escape={escape} role="lead" sound />);
    expect(document.querySelector('[data-escape-phase]')).toHaveAttribute(
      'data-escape-phase',
      'finale',
    );
    expect(screen.getByTestId('screen-finale')).toBeInTheDocument();
    expect(screen.queryByTestId('screen-pin')).toBeNull();
    expect(lane('t1')).toBeNull();
  });

  it('closed with a kept finale and no board: the finale with "Thanks for playing"', () => {
    draw({ finale: screenFinaleOf(), replay: 'done', closed: true });
    expect(screen.getByTestId('screen-finale')).toBeInTheDocument();
    expect(screen.getByText(/Thanks for playing/)).toBeInTheDocument();
    // The room is gone: no unlock click asked for.
    expect(screen.queryByTestId('sound-unlock')).toBeNull();
  });

  it('no board yet: a loading line', () => {
    draw({});
    expect(screen.getByText('Loading the escape room…')).toBeInTheDocument();
  });

  it('HOST_DISCONNECTED changes nothing, and a board after it still moves the lanes', () => {
    const { rerender } = draw({ board: running() });
    expect(lane('t1')).toHaveTextContent('0/2');
    rerender(
      page({ board: running() }, { view: { state: 'HOST_DISCONNECTED' as GameView['state'] } }),
    );
    expect(lane('t1')).toBeInTheDocument();
    expect(screen.queryByText(/host/i)).toBeNull();
    const moved = running();
    moved.teams[0] = { ...moved.teams[0], locksSolved: 1 };
    rerender(page({ board: moved }, { view: { state: 'HOST_DISCONNECTED' as GameView['state'] } }));
    expect(lane('t1')).toHaveTextContent('1/2');
  });

  it('paused: the race greyed (never faded: text stays at 7:1) under a "Paused" banner', () => {
    draw({
      board: running(20 * MIN, {
        clock: { serverNow: NOW, paused: true, elapsedMs: 0, limitMs: 45 * MIN },
      }),
    });
    const track = screen.getByTestId('screen-stage');
    expect(track).toHaveAttribute('data-paused', 'true');
    expect(track).toHaveClass('grayscale');
    expect(track.className).not.toContain('opacity-');
    expect(screen.getByTestId('paused-banner')).toHaveTextContent('Paused');
  });

  it('connectionLost: upstream banner, and the last view stays', () => {
    draw({ board: running() }, { view: { connectionLost: true } });
    expect(screen.getByText(/Connection lost/i)).toBeInTheDocument();
    expect(lane('t1')).toBeInTheDocument();
    expect(digits()).toHaveTextContent('20:00');
  });

  it('one server-time tick for the clock, the lanes and the sounds, with the client 5 min behind', () => {
    const OFFSET = 5 * MIN;
    // This device's clock is 5 min behind the server's.
    vi.setSystemTime(NOW - OFFSET);
    addClockSample(NOW - OFFSET, NOW, NOW - OFFSET);
    expect(serverNow()).toBe(NOW);
    draw({ board: running() });
    // On the server's clock: 20 min to the end, Team Red 2 min less.
    expect(digits()).toHaveTextContent('20:00');
    expect(lane('t1')).toHaveTextContent('18:00');
    expect(sounds.calls.at(-1)!.now).toBe(NOW);
    act(() => vi.advanceTimersByTime(61_000));
    expect(digits()).toHaveTextContent('18:59');
    expect(lane('t1')).toHaveTextContent('16:59');
    expect(sounds.calls.at(-1)!.now).toBe(NOW + 61_000);
  });

  it('sound on the projection and on a copy asked for it; never on a silent copy', () => {
    draw({ board: running() });
    expect(sounds.calls.at(-1)!.audible).toBe(true);
    expect(screen.getByTestId('sound-unlock')).toBeInTheDocument();
    sounds.calls.length = 0;
    draw({ board: running() }, { role: 'follow', sound: false });
    expect(sounds.calls.at(-1)!.audible).toBe(false);
    sounds.calls.length = 0;
    draw({ board: running() }, { role: 'follow', sound: true });
    expect(sounds.calls.at(-1)!.audible).toBe(true);
  });

  it("a copy asked for sound stays silent when the room's sound plays on the projection only", () => {
    // As upstream's quiz copy (screen-page.tsx): the remote copy hears only what reaches it.
    draw(
      { board: running() },
      { role: 'follow', sound: true, view: { gameAudioTarget: 'projection' } },
    );
    expect(sounds.calls.at(-1)!.audible).toBe(false);
    expect(screen.queryByTestId('sound-unlock')).toBeNull();
    sounds.calls.length = 0;
    draw({ board: running() }, { role: 'lead', view: { gameAudioTarget: 'projection' } });
    expect(sounds.calls.at(-1)!.audible).toBe(true);
  });

  it('the cursor hides after 3 s without moving, and comes back on a move', () => {
    draw({ board: running() });
    const frame = document.querySelector<HTMLElement>('[data-escape-phase]')!;
    expect(frame.className).not.toContain('cursor-none');
    act(() => vi.advanceTimersByTime(3_000));
    expect(frame.className).toContain('cursor-none');
    fireEvent.mouseMove(frame);
    expect(frame.className).not.toContain('cursor-none');
  });

  it('the theme frame: one em type base for the whole screen', () => {
    draw({ board: running() });
    const frame = document.querySelector<HTMLElement>('[data-escape-phase]')!;
    expect(frame.className).toContain('text-[clamp(1rem,2.6vmin,2.5rem)]');
    expect(within(frame).getByRole('list', { name: /race/i })).toBeInTheDocument();
  });
});

describe('the big screen colours (7:1 from the back of the room)', () => {
  const frame = () => document.querySelector<HTMLElement>('[data-escape-phase]')!;

  it("a theme whose background reads draws it, with the screen's tokens tuned to it", () => {
    draw({ board: running() }, { view: { theme: BUILTIN_THEME_VALUES.night } });
    expect(frame()).toHaveAttribute('data-palette', 'theme');
    expect(frame()).toHaveAttribute('data-tone', 'dark');
    expect(frame().style.getPropertyValue('--background')).toBe(
      BUILTIN_THEME_VALUES.night.background.color,
    );
    expect(frame().style.getPropertyValue('--muted-foreground')).not.toBe('');
  });

  it("a picture theme falls back to the screen's own plain tokens, in its tone", () => {
    draw({ board: running() }, { view: { theme: BUILTIN_THEME_VALUES.halloween } });
    expect(frame()).toHaveAttribute('data-palette', 'screen');
    expect(frame()).toHaveAttribute('data-tone', 'dark');
    expect(frame().style.getPropertyValue('--background')).toBe(OWN_TOKENS.dark.background);
  });

  it("no theme yet: the screen's own light tokens", () => {
    draw({ board: running() });
    expect(frame()).toHaveAttribute('data-palette', 'screen');
    expect(frame().style.getPropertyValue('--foreground')).toBe(OWN_TOKENS.light.foreground);
  });
});

describe('the big screen sizes its text in em', () => {
  const src = resolve(process.cwd(), 'src');
  const dir = resolve(src, 'game/escape/screen');
  const files = [
    ...readdirSync(dir)
      .filter((n) => /\.tsx?$/.test(n) && !/\.test\.tsx?$|-fixtures\.tsx?$/.test(n))
      .map((n) => join(dir, n)),
    resolve(src, 'routes/escape-screen-page.tsx'),
  ];
  // Tailwind's fixed sizes (rem) and any px font size would not follow the type base.
  const PX_TEXT = /\btext-(xs|sm|base|lg|[2-9]?xl)\b|\btext-\[[\d.]+(px|rem)\]/;

  it('catches a px or fixed text size', () => {
    expect(PX_TEXT.test('className="text-sm"')).toBe(true);
    expect(PX_TEXT.test('className="text-[18px]"')).toBe(true);
    expect(PX_TEXT.test('className="text-[1.4em] text-destructive"')).toBe(false);
  });

  it.each(files.map((p) => [p.slice(src.length + 1), p]))('%s', (_, path) => {
    expect(readFileSync(path, 'utf8')).not.toMatch(PX_TEXT);
  });
});
