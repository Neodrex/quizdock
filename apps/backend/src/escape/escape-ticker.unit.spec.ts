import { EscapeTicker } from './escape-ticker';

describe('EscapeTicker', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const logger = () => ({ error: jest.fn() });

  it('runs the task every period until stopped', async () => {
    const ticker = new EscapeTicker(logger());
    const task = jest.fn(async () => undefined);
    ticker.start('g', 50, task);
    expect(ticker.has('g')).toBe(true);
    await jest.advanceTimersByTimeAsync(160);
    expect(task).toHaveBeenCalledTimes(3);
    ticker.stop('g');
    expect(ticker.has('g')).toBe(false);
    await jest.advanceTimersByTimeAsync(200);
    expect(task).toHaveBeenCalledTimes(3);
  });

  it('never overlaps: a tick still running makes the next one skip', async () => {
    const ticker = new EscapeTicker(logger());
    let release!: () => void;
    const task = jest.fn(() => new Promise<void>((r) => (release = r)));
    ticker.start('g', 50, task);
    await jest.advanceTimersByTimeAsync(200);
    expect(task).toHaveBeenCalledTimes(1);
    release();
    await jest.advanceTimersByTimeAsync(50);
    expect(task).toHaveBeenCalledTimes(2);
    ticker.stopAll();
  });

  it('logs a failed tick and keeps ticking', async () => {
    const log = logger();
    const ticker = new EscapeTicker(log);
    const task = jest.fn(async () => {
      throw new Error('boom');
    });
    ticker.start('g', 50, task);
    await jest.advanceTimersByTimeAsync(110);
    expect(task).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith('escape tick g: boom');
    ticker.stopAll();
  });

  it('starting a key again replaces its interval; stopAll clears every key', async () => {
    const ticker = new EscapeTicker(logger());
    const first = jest.fn(async () => undefined);
    const second = jest.fn(async () => undefined);
    ticker.start('g', 50, first);
    ticker.start('g', 50, second);
    ticker.start('h', 50, second);
    await jest.advanceTimersByTimeAsync(60);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(2);
    ticker.stopAll();
    expect(ticker.has('g') || ticker.has('h')).toBe(false);
  });

  it('does not keep the process alive', () => {
    const unref = jest.fn();
    const spy = jest
      .spyOn(global, 'setInterval')
      .mockReturnValue({ unref } as unknown as NodeJS.Timeout);
    new EscapeTicker(logger()).start('g', 50, async () => undefined);
    expect(unref).toHaveBeenCalled();
    spy.mockRestore();
  });
});
