import type { EscapeTeamUpdate } from '@quiz-dock/contracts';
import type { GameId } from '../game/game.keys';
import { HeldSends, type Held, type HeldLane } from './escape-throttle';

/** A view as the throttle sees it: opaque; here a label of when it was read. */
type View = { at: string };

const wrong = (teamId: string): EscapeTeamUpdate => ({ kind: 'wrong', teamId, by: 'p1' });
const news = (teamId: string, id = 'g1') => ({
  id: id as GameId,
  teams: new Set([teamId]),
  updates: [wrong(teamId)],
});

function harness() {
  const sent: { pin: string; lane: HeldLane; v: View; what: Held }[] = [];
  let load: () => Promise<View | null> = async () => ({ at: 'fresh' });
  const warn = jest.fn();
  const throttle = new HeldSends<View>({
    send: (pin, lane, v, what) => {
      sent.push({ pin, lane, v, what });
      return what.board || what.host || !!what.news?.updates.length || !!what.news?.teams.size;
    },
    load: () => load(),
    warn,
  });
  return {
    throttle,
    sent,
    warn,
    setLoad: (f: () => Promise<View | null>) => (load = f),
    /** The teams of each send's news, in order. */
    order: () => sent.map((s) => [...(s.what.news?.teams ?? [])]),
  };
}

describe('HeldSends (M9 Batch 2 fix round)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('sends at once, then holds for the period and sends what came meanwhile, merged', async () => {
    const t = harness();
    t.throttle.request(
      '111111',
      'all',
      { at: 'now' },
      { board: true, host: false, news: news('a') },
      1000,
    );
    t.throttle.request(
      '111111',
      'all',
      { at: 'now' },
      { board: false, host: true, news: news('b') },
      1000,
    );
    t.throttle.request(
      '111111',
      'all',
      { at: 'now' },
      { board: false, host: false, news: news('c') },
      1000,
    );
    expect(t.order()).toEqual([['a']]);
    await jest.advanceTimersByTimeAsync(1000);
    expect(t.order()).toEqual([['a'], ['b', 'c']]);
    expect(t.sent[1]).toMatchObject({ v: { at: 'fresh' }, what: { board: false, host: true } });
    // Idle for a period: the entry goes.
    await jest.advanceTimersByTimeAsync(1000);
    expect(t.throttle.has('111111')).toBe(false);
  });

  it('news that comes while a flush reads its view waits for the next period, after the older', async () => {
    const t = harness();
    let release!: (v: View) => void;
    t.throttle.request('111111', 'all', { at: 'now' }, { board: true, host: false }, 1000);
    t.throttle.request(
      '111111',
      'all',
      { at: 'now' },
      { board: false, host: false, news: news('old') },
      1000,
    );
    t.setLoad(() => new Promise<View>((r) => (release = r)));
    await jest.advanceTimersByTimeAsync(1000); // the flush of 'old' reads its view
    t.throttle.request(
      '111111',
      'all',
      { at: 'now' },
      { board: false, host: false, news: news('new') },
      1000,
    );
    expect(t.order()).toEqual([[]]); // not 'new' before 'old'
    release({ at: 'fresh' });
    await jest.advanceTimersByTimeAsync(0);
    expect(t.order()).toEqual([[], ['old']]);
    t.setLoad(async () => ({ at: 'fresh' }));
    await jest.advanceTimersByTimeAsync(1000);
    expect(t.order()).toEqual([[], ['old'], ['new']]);
  });

  it('a failed flush keeps its news for the next one, before what came meanwhile', async () => {
    const t = harness();
    t.throttle.request('111111', 'all', { at: 'now' }, { board: true, host: false }, 1000);
    t.throttle.request(
      '111111',
      'all',
      { at: 'now' },
      { board: false, host: false, news: news('old') },
      1000,
    );
    let fail = true;
    let release!: () => void;
    t.setLoad(
      () =>
        new Promise<View>((resolve, reject) => {
          release = () => (fail ? reject(new Error('redis down')) : resolve({ at: 'fresh' }));
        }),
    );
    await jest.advanceTimersByTimeAsync(1000);
    t.throttle.request(
      '111111',
      'all',
      { at: 'now' },
      { board: false, host: false, news: news('new') },
      1000,
    );
    release();
    await jest.advanceTimersByTimeAsync(0);
    expect(t.warn).toHaveBeenCalledTimes(1);
    expect(t.order()).toEqual([[]]);
    fail = false;
    await jest.advanceTimersByTimeAsync(1000);
    release();
    await jest.advanceTimersByTimeAsync(0);
    expect(t.order()).toEqual([[], ['old', 'new']]);
    expect(t.sent[1].what.news?.updates.map((u) => u.teamId)).toEqual(['old', 'new']);
  });

  it('take: the held and the in-flight sends, the entry gone; the flush in flight sends nothing', async () => {
    const t = harness();
    let release!: (v: View) => void;
    t.throttle.request('111111', 'all', { at: 'now' }, { board: true, host: false }, 1000);
    t.throttle.request(
      '111111',
      'all',
      { at: 'now' },
      { board: false, host: false, news: news('old') },
      1000,
    );
    t.setLoad(() => new Promise<View>((r) => (release = r)));
    await jest.advanceTimersByTimeAsync(1000);
    t.throttle.request(
      '111111',
      'all',
      { at: 'now' },
      { board: false, host: true, news: news('new') },
      1000,
    );
    const took = t.throttle.take('111111', 'all');
    expect(took).toMatchObject({ board: false, host: true });
    expect([...(took?.news?.teams ?? [])]).toEqual(['old', 'new']);
    expect(t.throttle.has('111111')).toBe(false);
    release({ at: 'fresh' });
    await jest.advanceTimersByTimeAsync(5000);
    expect(t.order()).toEqual([[]]);
    expect(t.throttle.take('111111', 'all')).toBeNull();
  });

  it('lanes of one room are apart', async () => {
    const t = harness();
    t.throttle.request('111111', 'screens', { at: 'now' }, { board: true, host: false }, 100);
    t.throttle.request('111111', 'host', { at: 'now' }, { board: true, host: true }, 1000);
    t.throttle.request('111111', 'screens', { at: 'now' }, { board: true, host: false }, 100);
    expect(t.sent.map((s) => s.lane)).toEqual(['screens', 'host']);
    await jest.advanceTimersByTimeAsync(100);
    expect(t.sent.map((s) => s.lane)).toEqual(['screens', 'host', 'screens']);
    await jest.advanceTimersByTimeAsync(1100);
    expect(t.throttle.has('111111')).toBe(false);
  });

  it('a room gone meanwhile: the flush sends nothing and the entry goes', async () => {
    const t = harness();
    t.throttle.request('111111', 'all', { at: 'now' }, { board: true, host: false }, 1000);
    t.throttle.request('111111', 'all', { at: 'now' }, { board: true, host: false }, 1000);
    t.setLoad(async () => null);
    await jest.advanceTimersByTimeAsync(3000);
    expect(t.sent).toHaveLength(1);
    expect(t.throttle.has('111111')).toBe(false);
  });

  it('flushNow: what a lane holds goes out at once, after a flush in flight, then a fresh period', async () => {
    const t = harness();
    const req = (team: string) =>
      t.throttle.request(
        '111111',
        'host',
        { at: 'now' },
        { board: false, host: false, news: news(team) },
        1000,
      );
    req('a');
    req('b');
    await t.throttle.flushNow('111111', 'host');
    expect(t.order()).toEqual([['a'], ['b']]);
    // A flush in flight: flushNow waits for it, then sends what came meanwhile.
    req('c');
    let release!: (v: View) => void;
    t.setLoad(() => new Promise<View>((r) => (release = r)));
    await jest.advanceTimersByTimeAsync(1000);
    req('d');
    const done = t.throttle.flushNow('111111', 'host');
    release({ at: 'fresh' });
    await jest.advanceTimersByTimeAsync(0);
    release({ at: 'fresh' });
    await done;
    expect(t.order()).toEqual([['a'], ['b'], ['c'], ['d']]);
    // Nothing held: nothing sent.
    await t.throttle.flushNow('111111', 'host');
    expect(t.sent).toHaveLength(4);
  });

  it('a send that sent nothing opens no period: the next goes out at once', () => {
    const t = harness();
    t.throttle.request(
      '111111',
      'all',
      { at: 'now' },
      { board: false, host: false, news: null },
      1000,
    );
    expect(t.throttle.has('111111')).toBe(false);
    t.throttle.request('111111', 'all', { at: 'now' }, { board: true, host: false }, 1000);
    expect(t.sent.map((s) => s.what.board)).toEqual([false, true]);
    expect(t.throttle.has('111111')).toBe(true);
  });

  it('clear: nothing held, nothing sent later', async () => {
    const t = harness();
    t.throttle.request('111111', 'all', { at: 'now' }, { board: true, host: false }, 1000);
    t.throttle.request('111111', 'all', { at: 'now' }, { board: true, host: false }, 1000);
    t.throttle.clear();
    await jest.advanceTimersByTimeAsync(3000);
    expect(t.sent).toHaveLength(1);
    expect(t.throttle.has('111111')).toBe(false);
  });
});
