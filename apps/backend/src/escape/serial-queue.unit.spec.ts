import { SerialQueue } from './serial-queue';

const tick = () => new Promise<void>((r) => setImmediate(r));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('SerialQueue', () => {
  it('runs jobs for one key in order, even when an earlier one awaits', async () => {
    const q = new SerialQueue();
    const log: string[] = [];
    const gate = deferred();
    const first = q.run('g', async () => {
      log.push('1 start');
      await gate.promise;
      log.push('1 end');
      return 1;
    });
    const second = q.run('g', async () => {
      log.push('2');
      return 2;
    });
    await tick();
    expect(log).toEqual(['1 start']);
    gate.resolve();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(log).toEqual(['1 start', '1 end', '2']);
  });

  it('does not let a rejected job block the next', async () => {
    const q = new SerialQueue();
    const failed = q.run('g', async () => {
      throw new Error('refused');
    });
    const next = q.run('g', async () => 'ok');
    await expect(failed).rejects.toThrow('refused');
    await expect(next).resolves.toBe('ok');
  });

  it('runs different keys concurrently', async () => {
    const q = new SerialQueue();
    const gate = deferred();
    const log: string[] = [];
    const a = q.run('a', async () => {
      await gate.promise;
      log.push('a');
    });
    const b = q.run('b', async () => {
      log.push('b');
    });
    await b;
    expect(log).toEqual(['b']);
    gate.resolve();
    await a;
    expect(log).toEqual(['b', 'a']);
  });

  it('is empty once the queue drains', async () => {
    const q = new SerialQueue();
    const jobs = [
      q.run('a', async () => undefined),
      q.run('a', async () => {
        throw new Error('x');
      }),
      q.run('b', async () => undefined),
    ];
    expect(q.size).toBe(2);
    await Promise.allSettled(jobs);
    await tick();
    expect(q.size).toBe(0);
  });
});
