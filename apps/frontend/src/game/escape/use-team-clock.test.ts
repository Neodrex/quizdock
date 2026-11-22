import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClock } from '../clock';
import { type TeamClockInput, useTeamClock } from './use-team-clock';

const MIN = 60_000;

describe('useTeamClock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetClock(); // serverNow() is Date.now(), on the fake clock
  });
  afterEach(() => vi.useRealTimers());

  const running = (leftMs: number): TeamClockInput => ({
    deadlineAt: Date.now() + leftMs,
    remainingMs: leftMs,
    paused: false,
  });
  const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

  it('counts down on the deadline, never below 0', () => {
    const input = running(3_000);
    const { result } = renderHook(() => useTeamClock(input));
    expect(result.current.remainingMs).toBe(3_000);
    tick(1_000);
    expect(result.current.remainingMs).toBe(2_000);
    tick(10_000);
    expect(result.current.remainingMs).toBe(0);
  });

  it('stays frozen while paused', () => {
    const { result } = renderHook(() =>
      useTeamClock({ deadlineAt: null, remainingMs: 90_000, paused: true }),
    );
    tick(5_000);
    expect(result.current).toEqual({ remainingMs: 90_000, paused: true });
  });

  it('warns once at 5 minutes and once at 1 minute, going down', () => {
    const onWarning = vi.fn();
    const input = running(5 * MIN + 2_000);
    renderHook(() => useTeamClock(input, onWarning));
    tick(3_000);
    expect(onWarning).toHaveBeenCalledExactlyOnceWith(5);
    tick(MIN);
    expect(onWarning).toHaveBeenCalledTimes(1);
    tick(3 * MIN);
    expect(onWarning).toHaveBeenLastCalledWith(1);
    tick(2 * MIN);
    expect(onWarning).toHaveBeenCalledTimes(2);
  });

  it('extra time at 50 s left re-arms the 1-minute warning only', () => {
    const onWarning = vi.fn();
    const { rerender } = renderHook((c: TeamClockInput) => useTeamClock(c, onWarning), {
      initialProps: running(5 * MIN + 1_000),
    });
    tick(4 * MIN + 11_000); // 50 s left
    expect(onWarning.mock.calls).toEqual([[5], [1]]);
    rerender(running(50_000 + 120_000)); // the host adds 2 minutes: 2:50 left
    tick(2 * MIN);
    expect(onWarning.mock.calls).toEqual([[5], [1], [1]]);
  });

  it('a reload under a threshold does not warn for it', () => {
    const onWarning = vi.fn();
    const input = running(4 * MIN);
    renderHook(() => useTeamClock(input, onWarning));
    tick(10_000);
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('a resume after a pause neither warns again nor shows a stale first frame', () => {
    const onWarning = vi.fn();
    const start = running(5 * MIN + 1_000);
    const { result, rerender } = renderHook((c: TeamClockInput) => useTeamClock(c, onWarning), {
      initialProps: start,
    });
    tick(3_000); // 4:58 left: the 5-minute warning went
    expect(onWarning.mock.calls).toEqual([[5]]);
    rerender({ deadlineAt: null, remainingMs: 4 * MIN + 58_000, paused: true });
    tick(10_000);
    rerender(running(4 * MIN + 58_000));
    expect(result.current.remainingMs).toBe(4 * MIN + 58_000);
    tick(2_000);
    expect(onWarning.mock.calls).toEqual([[5]]);
  });
});
