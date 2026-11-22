import type { EscapeBoard, RoomSoundsPayload, ThemeValues } from '@quiz-dock/contracts';
import { act, render, renderHook, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../test-fixtures';
import { announceOf, boardOf, screenFinaleOf, summaryOf } from './screen-fixtures';
import type { Banner, EscapeScreenUi } from './screen-reducer';

// The Web Audio side is faked: the mixer, the unlock, the server clock, the effects.
const fake = vi.hoisted(() => ({
  unlocked: true,
  t: 1_000_000_000,
  effects: [] as { url: string | null; synth: unknown; at?: number; rate?: number }[],
  cancelled: [] as number[],
  levels: [] as [string, number][],
  track: [] as string[],
  bed: [] as string[],
}));

vi.mock('../../media/audio-mixer', () => ({
  TRACK_FADE_S: 1.5,
  getMixer: () => ({ ctx: { state: 'running', currentTime: 0 } }),
  busInput: () => ({}),
  setRoomLevel: (bus: string, v: number) => fake.levels.push([bus, v]),
  setDeviceMuted: () => undefined,
  loopTrack: () => ({
    play: () => fake.track.push('play'),
    hold: () => fake.track.push('hold'),
  }),
}));
vi.mock('../../media/audio-unlock', () => ({
  useAudioUnlocked: () => fake.unlocked,
  unlockAudio: () => {
    fake.unlocked = true;
    return Promise.resolve(true);
  },
}));
vi.mock('../../clock', async (orig) => ({
  ...(await orig<typeof import('../../clock')>()),
  serverNow: () => fake.t,
}));
vi.mock('../../media/game-sounds', async (orig) => ({
  ...(await orig<typeof import('../../media/game-sounds')>()),
  loadSound: () => Promise.resolve({ duration: 30 }),
  playEffect: (url: string | null, synth: unknown, at?: number, rate?: number) => {
    const i = fake.effects.push({ url, synth, at, rate }) - 1;
    return () => fake.cancelled.push(i);
  },
}));
vi.mock('./tension-bed', () => ({
  startTensionBed: () => {
    fake.bed.push('start');
    return {
      setUrgent: (u: boolean) => fake.bed.push(u ? 'urgent' : 'calm'),
      stop: () => fake.bed.push('stop'),
    };
  },
}));

import { synthDing, synthGong, synthTick, TAC_HZ, TIC_HZ } from '../../media/game-sounds';
import { ScreenSoundUnlock, useEscapeScreenSounds } from './screen-sounds';

const NOW = 1_000_000_000;
const MIN = 60_000;

const SOUNDS: RoomSoundsPayload = {
  tick: true,
  gong: true,
  countdown: true,
  ding: true,
  tickUrl: null,
  gongUrl: null,
  dingUrl: null,
  countdownUrl: null,
  musicUrl: null,
  musicLevel: 0.4,
  sfxLevel: 0.7,
  musicMuted: false,
  sfxMuted: false,
  mediaLevel: 1,
  mediaMuted: false,
  muted: false,
};

/** One team, its deadline `left` ms after NOW, in a 45-min run. */
const running = (left: number, over: Partial<EscapeBoard> = {}) =>
  boardOf({
    clock: { serverNow: NOW, paused: false, elapsedMs: 0, limitMs: 45 * MIN },
    teams: [summaryOf({ remainingMs: left, deadlineAt: NOW + left })],
    ...over,
  });

let seq = 1;
const shown = (over: Partial<Banner> = {}): Banner => ({
  ...announceOf(),
  id: seq++,
  durationMs: 4000,
  until: NOW + 4000,
  ...over,
});

type Ui = Pick<EscapeScreenUi, 'board' | 'current' | 'finale'>;
const ui = (over: Partial<Ui> = {}): Ui => ({
  board: running(20 * MIN),
  current: null,
  finale: null,
  ...over,
});

interface Props {
  u: Ui;
  s?: RoomSoundsPayload | null;
  audible?: boolean;
  now?: number;
  theme?: ThemeValues | null;
}
const hook = (initial: Props) =>
  renderHook(
    ({ u, s = SOUNDS, audible = true, now = NOW, theme = null }: Props) =>
      useEscapeScreenSounds(u, s, audible, { now, theme }),
    { initialProps: initial },
  );

const synths = () => fake.effects.map((e) => e.synth);
const clicks = () => fake.effects.filter((e) => e.synth !== synthGong);

beforeEach(() => {
  fake.unlocked = true;
  fake.t = NOW;
  fake.effects.length = 0;
  fake.cancelled.length = 0;
  fake.levels.length = 0;
  fake.track.length = 0;
  fake.bed.length = 0;
});
afterEach(() => vi.clearAllMocks());

describe('useEscapeScreenSounds: effects', () => {
  it('a shown stage clear dings once, an escape gongs, a hint ticks', () => {
    const first = shown();
    const { rerender } = hook({ u: ui({ current: first }) });
    rerender({ u: ui({ current: first }) });
    expect(synths()).toEqual([synthDing]);
    rerender({ u: ui({ current: shown({ kind: 'escaped' }) }) });
    rerender({ u: ui({ current: shown({ kind: 'hint' }) }) });
    expect(synths()).toEqual([synthDing, synthGong, synthTick]);
  });

  it('nothing before the unlock, when not audible, or when the room is muted', () => {
    fake.unlocked = false;
    const { rerender } = hook({ u: ui({ current: shown() }) });
    // Unlocked later: the banner already up does not sound late.
    fake.unlocked = true;
    rerender({ u: ui({ current: shown() }), audible: false });
    rerender({ u: ui({ current: shown() }), s: { ...SOUNDS, muted: true } });
    expect(fake.effects).toEqual([]);
  });

  it('each effect follows its room switch', () => {
    const off = { ...SOUNDS, ding: false, gong: false, tick: false };
    const { rerender } = hook({ u: ui({ current: shown() }), s: off });
    rerender({ u: ui({ current: shown({ kind: 'escaped' }) }), s: off });
    rerender({ u: ui({ current: shown({ kind: 'hint' }) }), s: off });
    expect(fake.effects).toEqual([]);
  });

  it("the room's sample first, then the theme's", () => {
    const theme = { sounds: { ding: '/theme/ding.mp3', gong: '/theme/gong.mp3' } } as never;
    const { rerender } = hook({ u: ui({ current: shown() }), theme });
    rerender({
      u: ui({ current: shown({ kind: 'escaped' }) }),
      s: { ...SOUNDS, gongUrl: '/room/gong.mp3' },
      theme,
    });
    expect(fake.effects.map((e) => e.url)).toEqual(['/theme/ding.mp3', '/room/gong.mp3']);
  });

  it('sets the music and effects buses from the room, both silent on mute', () => {
    const { rerender } = hook({ u: ui() });
    expect(fake.levels).toEqual(
      expect.arrayContaining([
        ['music', 0.4],
        ['sfx', 0.7],
      ]),
    );
    fake.levels.length = 0;
    rerender({ u: ui(), s: { ...SOUNDS, muted: true } });
    expect(fake.levels).toEqual(
      expect.arrayContaining([
        ['music', 0],
        ['sfx', 0],
      ]),
    );
  });
});

describe('useEscapeScreenSounds: tic-tac', () => {
  it('19 half-beats over the last 10 s (no last tac), then the gong on zero', () => {
    hook({ u: ui({ board: running(10_000) }) });
    const ticks = clicks();
    expect(ticks).toHaveLength(19);
    expect(ticks[0]).toMatchObject({ at: 0, rate: 1 });
    expect(ticks[1]).toMatchObject({ at: 0.5, rate: TAC_HZ / TIC_HZ });
    expect(ticks[18]).toMatchObject({ at: 9, rate: 1 });
    expect(fake.effects.filter((e) => e.synth === synthGong)).toEqual([
      expect.objectContaining({ at: 10 }),
    ]);
    expect(TIC_HZ).toBeGreaterThan(TAC_HZ);
  });

  it('not before the last seconds; the gong alone when the countdown is off', () => {
    const { rerender } = hook({ u: ui({ board: running(5 * MIN) }) });
    expect(fake.effects).toEqual([]);
    rerender({ u: ui({ board: running(8000) }), s: { ...SOUNDS, countdown: false } });
    expect(synths()).toEqual([synthGong]);
  });

  it('a pause calls off what has not sounded', () => {
    const board = running(10_000);
    const { rerender } = hook({ u: ui({ board }) });
    const scheduled = fake.effects.length;
    rerender({ u: ui({ board: { ...board, clock: { ...board.clock, paused: true } } }) });
    expect(fake.cancelled).toHaveLength(scheduled);
  });

  it('the last team out calls it off too', () => {
    const board = running(10_000);
    const { rerender } = hook({ u: ui({ board }) });
    rerender({
      u: ui({ board: { ...board, teams: [{ ...board.teams[0], escaped: true }] } }),
    });
    expect(fake.cancelled).toHaveLength(20);
  });

  it('time up on zero: the struck gong is not called off, and a time-up banner adds none', () => {
    const board = running(10_000);
    const { rerender } = hook({ u: ui({ board }) });
    fake.t = NOW + 10_000;
    const out = { ...board, teams: [{ ...board.teams[0], timedOut: true, remainingMs: 0 }] };
    rerender({ u: ui({ board: out }), now: NOW + 10_000 });
    const gong = fake.effects.findIndex((e) => e.synth === synthGong);
    expect(fake.cancelled).not.toContain(gong);
    rerender({ u: ui({ board: out, current: shown({ kind: 'time-up' }) }), now: NOW + 10_000 });
    expect(fake.effects.filter((e) => e.synth === synthGong)).toHaveLength(1);
  });

  it('a team timing out away from the run clock gets its gong', () => {
    hook({ u: ui({ current: shown({ kind: 'time-up' }) }) });
    expect(synths()).toEqual([synthGong]);
  });
});

describe('useEscapeScreenSounds: tension music', () => {
  it('the bed starts in the final minutes, quickens in the last minute, fades out on pause', () => {
    const { rerender } = hook({ u: ui({ board: running(6 * MIN) }) });
    expect(fake.bed).toEqual([]);
    rerender({ u: ui({ board: running(5 * MIN) }) });
    expect(fake.bed).toEqual(['start', 'calm']);
    rerender({ u: ui({ board: running(MIN) }) });
    expect(fake.bed.at(-1)).toBe('urgent');
    const b = running(MIN);
    rerender({ u: ui({ board: { ...b, clock: { ...b.clock, paused: true } } }) });
    expect(fake.bed.at(-1)).toBe('stop');
  });

  it('3 minutes for a run under 30 minutes', () => {
    const short = (left: number) => {
      const b = running(left);
      return { ...b, clock: { ...b.clock, limitMs: 20 * MIN } };
    };
    const { rerender } = hook({ u: ui({ board: short(4 * MIN) }) });
    expect(fake.bed).toEqual([]);
    rerender({ u: ui({ board: short(3 * MIN) }) });
    expect(fake.bed[0]).toBe('start');
  });

  it('fades out at the finale and on mute', () => {
    const { rerender } = hook({ u: ui({ board: running(2 * MIN) }) });
    rerender({ u: ui({ board: running(2 * MIN), finale: screenFinaleOf() }) });
    expect(fake.bed).toEqual(['start', 'calm', 'stop']);
    fake.bed.length = 0;
    const again = hook({ u: ui({ board: running(2 * MIN) }) });
    again.rerender({ u: ui({ board: running(2 * MIN) }), s: { ...SOUNDS, muted: true } });
    expect(fake.bed.at(-1)).toBe('stop');
  });

  it("the room's track loops instead of the bed when the host picked one", async () => {
    const s = { ...SOUNDS, musicUrl: '/room/track.mp3' };
    const { rerender } = hook({ u: ui({ board: running(10 * MIN) }), s });
    await act(async () => undefined);
    expect(fake.track).toEqual(['hold']);
    rerender({ u: ui({ board: running(4 * MIN) }), s });
    expect(fake.track.at(-1)).toBe('play');
    rerender({ u: ui({ board: running(4 * MIN), finale: screenFinaleOf() }), s });
    expect(fake.track.at(-1)).toBe('hold');
    expect(fake.bed).toEqual([]);
  });
});

describe('ScreenSoundUnlock', () => {
  const draw = (audible: boolean) =>
    render(
      <I18nextProvider i18n={en}>
        <ScreenSoundUnlock audible={audible} />
      </I18nextProvider>,
    );

  it('asks on the projection until the click', () => {
    fake.unlocked = false;
    draw(true);
    expect(
      screen.getByRole('button', { name: en.t('live:media.enableSound') }),
    ).toBeInTheDocument();
  });

  it('never on a follow copy without ?sound=1, nor once unlocked', () => {
    fake.unlocked = false;
    const { unmount } = draw(false);
    expect(screen.queryByText(en.t('live:media.enableSound'))).toBeNull();
    unmount();
    fake.unlocked = true;
    draw(true);
    expect(screen.queryByText(en.t('live:media.enableSound'))).toBeNull();
  });
});
