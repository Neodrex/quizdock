import type { ModuleRef } from '@nestjs/core';
import type { GameService } from '../game/game.service';
import type { GameMeta } from '../game/game.types';
import type { RedisService } from '../redis/redis.service';
import type { EscapeAttempts } from './escape-attempts';
import type { EscapeRun } from './escape-live.types';
import type { EscapeTemplatesService } from './escape-templates.service';
import { EscapeTimings } from './escape-timings';
import { EscapeEngine } from './escape.engine';
import type { EscapeStore } from './escape.store';
import { NoLicences } from './licences/no-licences';

const run = (phase: EscapeRun['phase']): EscapeRun => ({
  phase,
  formation: 'auto',
  maxSize: 0,
  teamIds: ['t1'],
  clock: { startedAt: 1, pausedAt: 0, pausedMs: 0, endedElapsedMs: null, limitMs: 60_000 },
});

/** V1: the ticker lives in this process; after a restart it is started again from Redis. */
describe('EscapeEngine.recover (bindServer)', () => {
  it('starts the ticker for escape games in phase running only', async () => {
    const metas: Record<string, Partial<Omit<GameMeta, 'id'>> & { id: string }> = {
      '111111': { id: 'g1', kind: 'escape' },
      '222222': { id: 'g2', kind: 'escape' },
      '333333': { id: 'g3', kind: 'escape' },
      '444444': { id: 'g4' },
    };
    const runs: Record<string, EscapeRun> = {
      g1: run('running'),
      g2: run('forming'),
      g3: run('finale'),
      g4: run('running'),
    };
    const redis = {
      scanKeys: jest.fn(async () => [
        ...Object.keys(metas).map((p) => `room:${p}`),
        'room:111111:players',
      ]),
    };
    const game = { getMeta: jest.fn(async (pin: string) => metas[pin] ?? null) };
    const store = { run: jest.fn(async (id: string) => runs[id] ?? null) };
    const engine = new EscapeEngine(
      game as unknown as GameService,
      store as unknown as EscapeStore,
      {} as EscapeTemplatesService,
      new EscapeTimings(),
      redis as unknown as RedisService,
      {} as EscapeAttempts,
      { get: () => ({}) } as unknown as ModuleRef,
      new NoLicences(),
    );
    const ticker = (engine as unknown as { ticker: { start: (...a: unknown[]) => void } }).ticker;
    const start = jest.spyOn(ticker, 'start').mockImplementation(() => undefined);
    engine.bindServer({} as never);
    await new Promise((r) => setTimeout(r, 10));
    expect(start.mock.calls.map(([key]) => key)).toEqual(['g1']);
    expect(start.mock.calls[0][1]).toBe(1000);
  });
});
