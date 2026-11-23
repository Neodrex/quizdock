import { EscapeScheduler } from './escape-scheduler';

describe('EscapeScheduler (M7 §1.7)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const tasks = () => ({
    fire: jest.fn(async () => undefined),
    touch: jest.fn(async () => undefined),
    touchEveryMs: 1_000,
  });
  const log = { error: jest.fn() };

  it('fires once at the start time and touches the room while it waits', () => {
    const s = new EscapeScheduler(log);
    const t = tasks();
    s.arm('111111', Date.now() + 3_500, t);
    expect(s.has('111111')).toBe(true);
    jest.advanceTimersByTime(3_499);
    expect(t.fire).not.toHaveBeenCalled();
    expect(t.touch).toHaveBeenCalledTimes(3);
    jest.advanceTimersByTime(1);
    expect(t.fire).toHaveBeenCalledTimes(1);
    expect(s.has('111111')).toBe(false);
    jest.advanceTimersByTime(10_000);
    expect(t.fire).toHaveBeenCalledTimes(1);
    expect(t.touch).toHaveBeenCalledTimes(3);
  });

  it('a start time already past fires at once', () => {
    const s = new EscapeScheduler(log);
    const t = tasks();
    s.arm('111111', Date.now() - 60_000, t);
    jest.advanceTimersByTime(0);
    expect(t.fire).toHaveBeenCalledTimes(1);
  });

  it('disarm cancels; arming again replaces the first', () => {
    const s = new EscapeScheduler(log);
    const first = tasks();
    const second = tasks();
    s.arm('111111', Date.now() + 1_000, first);
    s.arm('111111', Date.now() + 2_000, second);
    jest.advanceTimersByTime(5_000);
    expect(first.fire).not.toHaveBeenCalled();
    expect(second.fire).toHaveBeenCalledTimes(1);
    const third = tasks();
    s.arm('111111', Date.now() + 1_000, third);
    s.disarm('111111');
    jest.advanceTimersByTime(5_000);
    expect(third.fire).not.toHaveBeenCalled();
    expect(third.touch).not.toHaveBeenCalled();
  });

  it('stopAll clears every room', () => {
    const s = new EscapeScheduler(log);
    const a = tasks();
    const b = tasks();
    s.arm('111111', Date.now() + 1_000, a);
    s.arm('222222', Date.now() + 1_000, b);
    s.stopAll();
    expect(s.has('111111') || s.has('222222')).toBe(false);
    jest.advanceTimersByTime(5_000);
    expect(a.fire).not.toHaveBeenCalled();
    expect(b.fire).not.toHaveBeenCalled();
  });

  it('logs a failed start, never throws', async () => {
    const s = new EscapeScheduler(log);
    s.arm('111111', Date.now(), {
      fire: async () => {
        throw new Error('boom');
      },
      touch: async () => undefined,
      touchEveryMs: 1_000,
    });
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(log.error).toHaveBeenCalledWith('race start 111111: boom');
  });
});
