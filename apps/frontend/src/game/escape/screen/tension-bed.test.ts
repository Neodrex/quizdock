import { beforeEach, describe, expect, it, vi } from 'vitest';

// A fake Web Audio graph: records the oscillators, their frequencies and the gain ramps.
const { mixer, oscs, ramps, filters, ended, disconnected } = vi.hoisted(() => {
  const ended: (() => void)[] = [];
  const disconnected = { count: 0 };
  const disconnect = () => {
    disconnected.count++;
  };
  const oscs: { type: string; freq: number[]; started: boolean; stopped: number | null }[] = [];
  const ramps: { to: number; at: number }[] = [];
  const filters: { type: string; freq: number }[] = [];
  const param = (log?: number[]) => ({
    value: 0,
    setValueAtTime(v: number) {
      log?.push(v);
    },
    setTargetAtTime(v: number) {
      log?.push(v);
    },
    linearRampToValueAtTime(to: number, at: number) {
      ramps.push({ to, at });
    },
    cancelScheduledValues: () => undefined,
  });
  const ctx = {
    state: 'running',
    currentTime: 10,
    createGain: () => ({ connect: (n: unknown) => n, disconnect, gain: param() }),
    createBiquadFilter: () => {
      const f = { type: '', freq: 0 };
      filters.push(f);
      return {
        connect: (n: unknown) => n,
        disconnect,
        set type(v: string) {
          f.type = v;
        },
        frequency: {
          ...param(),
          set value(v: number) {
            f.freq = v;
          },
        },
        Q: param(),
      };
    },
    createOscillator: () => {
      const o = { type: '', freq: [] as number[], started: false, stopped: null as number | null };
      oscs.push(o);
      return {
        connect: (n: unknown) => n,
        disconnect,
        set type(v: string) {
          o.type = v;
        },
        frequency: {
          ...param(o.freq),
          set value(v: number) {
            o.freq.push(v);
          },
        },
        start: () => {
          o.started = true;
        },
        set onended(f: () => void) {
          ended.push(f);
        },
        stop: (at: number) => {
          o.stopped = at;
        },
      };
    },
  };
  return { mixer: { ctx }, oscs, ramps, filters, ended, disconnected };
});

vi.mock('../../media/audio-mixer', () => ({
  getMixer: () => mixer,
  busInput: (bus: string) => (bus === 'music' ? {} : null),
}));

import { BED_HZ, PULSE_HZ, startTensionBed, URGENT_PULSE_HZ } from './tension-bed';

beforeEach(() => {
  oscs.length = 0;
  ramps.length = 0;
  filters.length = 0;
  ended.length = 0;
  disconnected.count = 0;
});

describe('tension bed', () => {
  it('a low sine pulsed at 2 Hz, through a low-pass, fading in', () => {
    startTensionBed({ fadeInS: 1.5 });
    const [tone, lfo] = oscs;
    expect(tone).toMatchObject({ type: 'sine', started: true });
    expect(tone.freq).toContain(BED_HZ);
    expect(BED_HZ).toBe(55);
    expect(lfo.freq).toContain(PULSE_HZ);
    expect(filters.some((f) => f.type === 'lowpass')).toBe(true);
    expect(ramps).toContainEqual({ to: 1, at: 11.5 });
  });

  it('its pulse rises in the last minute', () => {
    const bed = startTensionBed({ fadeInS: 1 });
    bed.setUrgent(true);
    expect(oscs[1].freq.at(-1)).toBe(URGENT_PULSE_HZ);
    expect(URGENT_PULSE_HZ).toBe(2.5);
    bed.setUrgent(false);
    expect(oscs[1].freq.at(-1)).toBe(PULSE_HZ);
  });

  it('fades out and stops once', () => {
    const bed = startTensionBed({ fadeInS: 1 });
    ramps.length = 0;
    bed.stop(1.5);
    expect(ramps).toContainEqual({ to: 0, at: 11.5 });
    expect(oscs.every((o) => o.stopped !== null && o.stopped > 11.5)).toBe(true);
    ramps.length = 0;
    bed.stop(1.5);
    expect(ramps).toEqual([]);
  });

  it('lets go of its nodes once they have ended', () => {
    const bed = startTensionBed({ fadeInS: 1 });
    bed.stop(1);
    expect(disconnected.count).toBe(0);
    ended.forEach((f) => f());
    expect(disconnected.count).toBeGreaterThanOrEqual(7);
  });
});
