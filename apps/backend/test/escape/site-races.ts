import { Logger } from '@nestjs/common';
import { type EscapeFinale, type EscapeHostState, GameState } from '@quiz-dock/contracts';
import type { Socket } from 'socket.io-client';
import { EscapeEngine } from '../../src/escape/escape.engine';
import { EscapeStore } from '../../src/escape/escape.store';
import { EscapeTimings } from '../../src/escape/escape-timings';
import { GameService } from '../../src/game/game.service';
import type { RaceResults } from '../../src/escape/races/race.port';
import { SiteRaces } from '../../src/escape/races/site-races';
import { lostLibrary } from '../../src/escape/samples';
import { nextEvent, settle } from '../game-harness';
import {
  type EscapeContext,
  type SyncedPlayer,
  createAs,
  eventually,
  joinAndSync,
  record,
  seedTemplate,
  stateWhere,
} from './escape-harness';
import { sessionLeaksIn } from './leaks';
import { type SiteStub, startSiteStub, swapPort } from './site-stub';

const MIN = 60_000;
const RACE = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const claimPath = `/api/live/races/${RACE}/claim`;
const openedPath = `/api/live/races/${RACE}/opened`;
const resultsPath = `/api/live/races/${RACE}/results`;

/**
 * M8 Task 8.14: a race opened from the Site. Live claims it (the Site's start,
 * format and brand win), sends the PIN back, and reports the top teams after
 * the finale. A stub of the Site's API stands behind a real SiteRaces.
 */
export function siteRaceTests(ctx: EscapeContext): void {
  let library: string;
  let site: SiteStub;
  let undo: (() => void) | undefined;
  const store = () => ctx.h.app.get(EscapeStore);
  const refused = (code: string) => ({ ok: false, error: expect.objectContaining({ code }) });
  const calls = (path: string) => site.calls.filter((c) => c.path === path);

  beforeAll(async () => {
    library = await seedTemplate(ctx.h, lostLibrary);
    site = await startSiteStub();
  });

  afterAll(async () => {
    undo?.();
    await site?.close();
  });

  it('without a Site (NoRaces) a Site race is not found, and no room opens', async () => {
    const host = ctx.h.connectHost();
    expect(
      await createAs(host, library, 'race', { race: { format: 'solo', siteRaceId: RACE } }),
    ).toMatchObject(refused('escape.race_not_found'));
  });

  describe('with the Site', () => {
    let startsAt: number;

    beforeAll(() => {
      const races = new SiteRaces(site.client(), new Logger('SiteRaces'));
      undo = swapPort(ctx.h.app.get(EscapeEngine), 'races', races);
    });

    beforeEach(() => {
      site.reset();
      startsAt = Date.now() + 30 * MIN;
      site.answers.set(claimPath, () => ({
        ok: true,
        race: { title: 'Friday race', startsAt, format: 'teams', brand: null },
      }));
      site.answers.set(openedPath, { ok: true });
      site.answers.set(resultsPath, { ok: true });
    });

    const siteRace = async (): Promise<{
      host: Socket;
      pin: string;
      hostSeen: [string, unknown][];
    }> => {
      const host = ctx.h.connectHost();
      const hostSeen = record(host);
      const { pin, error } = await createAs(host, library, 'race', {
        race: { format: 'solo', siteRaceId: RACE },
      });
      if (!pin) throw new Error(`site race refused: ${error?.code}`);
      expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
      return { host, pin, hostSeen };
    };

    it.each([
      ['not-found', 'escape.race_not_found'],
      ['not-allowed', 'escape.race_not_allowed'],
      ['not-open', 'escape.race_not_open'],
    ])('a claim refused as %s is %s, and opens no room', async (reason, code) => {
      site.answers.set(claimPath, { ok: false, reason });
      const host = ctx.h.connectHost();
      expect(
        await createAs(host, library, 'race', { race: { format: 'solo', siteRaceId: RACE } }),
      ).toMatchObject(refused(code));
      expect(calls(openedPath)).toEqual([]);
    });

    it('the Site down: escape.race_unavailable, no room', async () => {
      site.down = true;
      const host = ctx.h.connectHost();
      expect(
        await createAs(host, library, 'race', { race: { format: 'solo', siteRaceId: RACE } }),
      ).toMatchObject(refused('escape.race_unavailable'));
      expect(calls(openedPath)).toEqual([]);
    });

    it('the Site’s start and format win over the dialog’s; the Site gets the PIN', async () => {
      const host = ctx.h.connectHost();
      const { pin } = await createAs(host, library, 'race', {
        race: { format: 'solo', startsAt: Date.now() + 90 * MIN, siteRaceId: RACE },
      });
      expect(pin).toMatch(/^\d{6}$/);
      expect((await store().session(pin!))?.race).toEqual({
        format: 'teams',
        startsAt,
        started: false,
        siteRaceId: RACE,
        brand: null,
      });
      expect(calls(claimPath)[0].body).toEqual({
        host: { subject: 'local:animateur', email: null },
      });
      expect(calls(openedPath)).toEqual([{ path: openedPath, body: { pin } }]);
    });

    it('an opened refused as not-found: logged, the room stays open, unlinked, no retry', async () => {
      site.answers.set(openedPath, { ok: false, reason: 'not-found' });
      const { pin, hostSeen } = await siteRace();
      expect((await store().session(pin))?.race).toMatchObject({
        siteRaceId: RACE,
        siteLinked: false,
        siteMissing: true,
      });
      const meta = (await ctx.h.app.get(GameService).getMeta(pin))!;
      const engine = ctx.h.app.get(EscapeEngine);
      expect(engine.inProcess(meta.id, pin).siteRetry).toBe(false);
      // The reason survives a restart: recover does not retry it either.
      await (engine as unknown as { recoverRoom(pin: string): Promise<void> }).recoverRoom(pin);
      expect(engine.inProcess(meta.id, pin).siteRetry).toBe(false);
      await eventually(async () =>
        expect(
          (hostSeen.filter(([e]) => e === 'escape:host').at(-1)?.[1] as EscapeHostState)?.session
            ?.race,
        ).toMatchObject({ siteLinked: false, siteMissing: true }),
      );
      expect(sessionLeaksIn(hostSeen, { siteRaceId: RACE, host: true })).toEqual([]);
    });

    it('a not-found room starts without asking the Site again', async () => {
      site.answers.set(openedPath, { ok: false, reason: 'not-found' });
      const { host, pin } = await siteRace();
      const phone = await joinAndSync(ctx.h, pin, 'Ann');
      const running = stateWhere(phone.socket, (s) => s.phase === 'running');
      expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
      await running;
      expect(calls(openedPath)).toHaveLength(1);
      expect((await store().session(pin))?.race).toMatchObject({
        started: true,
        siteLinked: false,
        siteMissing: true,
      });
    });

    describe('the Site unreachable at the open (M9 Task 9.6)', () => {
      const timings = () => ctx.h.app.get(EscapeTimings);
      const engine = () => ctx.h.app.get(EscapeEngine);
      let saved: number;
      beforeAll(() => {
        saved = timings().siteRetryMs;
        timings().siteRetryMs = 150;
      });
      afterAll(() => {
        timings().siteRetryMs = saved;
      });
      beforeEach(() => site.answers.delete(openedPath)); // the stub answers 404: unavailable

      /** The race of the last host state the console got. */
      const lastRace = (seen: [string, unknown][]) =>
        (seen.filter(([e]) => e === 'escape:host').at(-1)?.[1] as EscapeHostState | undefined)
          ?.session?.race;
      const idOf = async (pin: string) => (await ctx.h.app.get(GameService).getMeta(pin))!.id;

      it('the console says so; Live retries until the Site answers, then the notice clears', async () => {
        const { pin, hostSeen } = await siteRace();
        await eventually(async () =>
          expect(lastRace(hostSeen)).toMatchObject({ siteLinked: false }),
        );
        expect((await store().session(pin))?.race?.siteLinked).toBe(false);
        await eventually(async () => expect(calls(openedPath).length).toBeGreaterThanOrEqual(3));
        site.answers.set(openedPath, { ok: true });
        await eventually(async () =>
          expect(lastRace(hostSeen)).toMatchObject({ siteLinked: true }),
        );
        expect((await store().session(pin))?.race?.siteLinked).toBe(true);
        expect(lastRace(hostSeen)).not.toHaveProperty('siteLost');
        expect(engine().inProcess(await idOf(pin), pin).siteRetry).toBe(false);
        const n = calls(openedPath).length;
        await settle(450);
        expect(calls(openedPath)).toHaveLength(n);
        expect(calls(openedPath).every((c) => (c.body as { pin: string }).pin === pin)).toBe(true);
        expect(sessionLeaksIn(hostSeen, { siteRaceId: RACE, host: true })).toEqual([]);
      });

      it('the start tries once more, under the queue, and stops the retries', async () => {
        timings().siteRetryMs = 60_000;
        try {
          const { host, pin, hostSeen } = await siteRace();
          const phone = await joinAndSync(ctx.h, pin, 'Ann');
          const phoneSeen = record(phone.socket);
          expect(calls(openedPath)).toHaveLength(1);
          expect(engine().inProcess(await idOf(pin), pin).siteRetry).toBe(true);
          site.answers.set(openedPath, { ok: true });
          const running = stateWhere(phone.socket, (s) => s.phase === 'running');
          expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
          await running;
          expect(calls(openedPath)).toHaveLength(2);
          expect(engine().inProcess(await idOf(pin), pin).siteRetry).toBe(false);
          expect((await store().session(pin))?.race).toMatchObject({
            started: true,
            siteLinked: true,
          });
          await eventually(async () =>
            expect(lastRace(hostSeen)).toMatchObject({ started: true, siteLinked: true }),
          );
          expect(sessionLeaksIn(phoneSeen, { siteRaceId: RACE })).toEqual([]);
        } finally {
          timings().siteRetryMs = 150;
        }
      });

      it('the start with the Site still down: no more retries after it', async () => {
        const { host, pin } = await siteRace();
        const phone = await joinAndSync(ctx.h, pin, 'Ann');
        const running = stateWhere(phone.socket, (s) => s.phase === 'running');
        expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
        await running;
        expect(engine().inProcess(await idOf(pin), pin).siteRetry).toBe(false);
        expect((await store().session(pin))?.race).toMatchObject({
          started: true,
          siteLinked: false,
        });
        const n = calls(openedPath).length;
        await settle(450);
        expect(calls(openedPath)).toHaveLength(n);
      });

      it('the room ending stops the retries', async () => {
        // A period the test never reaches: only the end can clear the timer.
        timings().siteRetryMs = 60_000;
        try {
          const { host, pin } = await siteRace();
          const id = await idOf(pin);
          expect(engine().inProcess(id, pin).siteRetry).toBe(true);
          const ended = nextEvent(host, 'game:ended');
          host.emit('host:end', { pin });
          await ended;
          expect(engine().inProcess(id, pin).siteRetry).toBe(false);
        } finally {
          timings().siteRetryMs = 150;
        }
      });

      type Inner = { disarmSiteRetry(pin: string): void; recoverRoom(pin: string): Promise<void> };
      const inner = () => engine() as unknown as Inner;

      it('recover re-arms a waiting room, whose retry then links it', async () => {
        timings().siteRetryMs = 60_000;
        let pin = '';
        try {
          ({ pin } = await siteRace());
          const id = await idOf(pin);
          // What a restart loses: the timer.
          inner().disarmSiteRetry(pin);
          expect(engine().inProcess(id, pin).siteRetry).toBe(false);
          timings().siteRetryMs = 150;
          await inner().recoverRoom(pin);
          expect(engine().inProcess(id, pin).siteRetry).toBe(true);
          site.answers.set(openedPath, { ok: true });
          await eventually(async () =>
            expect((await store().session(pin))?.race?.siteLinked).toBe(true),
          );
          expect(engine().inProcess(id, pin).siteRetry).toBe(false);
        } finally {
          timings().siteRetryMs = 150;
        }
      });

      it('recover does not re-arm a started or a lost room', async () => {
        timings().siteRetryMs = 60_000;
        try {
          // Started: the session says so, the run is running.
          const a = await siteRace();
          const phone = await joinAndSync(ctx.h, a.pin, 'Ann');
          const running = stateWhere(phone.socket, (s) => s.phase === 'running');
          expect(await a.host.emitWithAck('escape:start', { pin: a.pin })).toEqual({ ok: true });
          await running;
          await inner().recoverRoom(a.pin);
          expect(engine().inProcess(await idOf(a.pin), a.pin).siteRetry).toBe(false);
          // Lost: another room won on the Site; the room is still forming.
          const b = await siteRace();
          inner().disarmSiteRetry(b.pin);
          const session = (await store().session(b.pin))!;
          await store().writeSession(b.pin, {
            ...session,
            race: { ...session.race!, siteLinked: false, siteLost: true },
          });
          await inner().recoverRoom(b.pin);
          expect(engine().inProcess(await idOf(b.pin), b.pin).siteRetry).toBe(false);
        } finally {
          timings().siteRetryMs = 150;
        }
      });

      it('a re-open during a retry in flight keeps the retries going', async () => {
        timings().siteRetryMs = 60_000;
        try {
          const { host, pin } = await siteRace();
          inner().disarmSiteRetry(pin);
          // The Site answers only once the room has a new run.
          let release!: () => void;
          const held = new Promise<void>((r) => (release = r));
          const slow = jest.spyOn(engine()['races'], 'opened').mockImplementationOnce(async () => {
            await held;
            return { ok: false, reason: 'unavailable' };
          });
          try {
            const retry = (
              engine() as unknown as { retrySite(pin: string): Promise<void> }
            ).retrySite(pin);
            await eventually(async () => expect(slow).toHaveBeenCalled());
            expect(
              await host.emitWithAck('escape:open', { pin, templateId: library }),
            ).toMatchObject({ ok: true });
            release();
            await retry;
          } finally {
            slow.mockRestore();
          }
          expect(engine().inProcess(await idOf(pin), pin).siteRetry).toBe(true);
        } finally {
          timings().siteRetryMs = 150;
        }
      });

      it('not-open on a retry: another room won; this one keeps running, with the second notice', async () => {
        const { pin, hostSeen } = await siteRace();
        site.answers.set(openedPath, { ok: false, reason: 'not-open' });
        await eventually(async () =>
          expect(lastRace(hostSeen)).toMatchObject({ siteLinked: false, siteLost: true }),
        );
        expect((await store().session(pin))?.race).toMatchObject({
          siteLinked: false,
          siteLost: true,
        });
        expect((await ctx.h.app.get(GameService).getMeta(pin))?.state).toBe(GameState.Lobby);
        expect(engine().inProcess(await idOf(pin), pin).siteRetry).toBe(false);
        const n = calls(openedPath).length;
        await settle(450);
        expect(calls(openedPath)).toHaveLength(n);
      });
    });

    it('two creates race to open the same race: exactly one room survives', async () => {
      let winner: string | null = null;
      site.answers.set(openedPath, (body: unknown) => {
        const { pin } = body as { pin: string };
        winner ??= pin;
        return winner === pin ? { ok: true } : { ok: false, reason: 'not-open' };
      });
      const acks = await Promise.all(
        [ctx.h.connectHost(), ctx.h.connectHost()].map((host) =>
          createAs(host, library, 'race', { race: { format: 'solo', siteRaceId: RACE } }),
        ),
      );
      const won = acks.filter((a) => a.pin);
      expect(won).toEqual([{ pin: winner }]);
      expect(acks.filter((a) => !a.pin)).toMatchObject([refused('escape.race_not_open')]);
      const pins = calls(openedPath).map((c) => (c.body as { pin: string }).pin);
      expect(pins).toHaveLength(2);
      const loser = pins.find((p) => p !== winner)!;
      const games = ctx.h.app.get(GameService);
      const won_ = (await games.getMeta(winner!))!;
      expect(won_.state).not.toBe(GameState.Ended);
      expect((await games.getMeta(loser))?.state ?? GameState.Ended).toBe(GameState.Ended);
      expect(await games.listActiveHostGames(won_.hostUserId)).not.toContainEqual(
        expect.objectContaining({ pin: loser }),
      );
      expect(ctx.h.app.get(EscapeEngine).inProcess(won_.id, loser).scheduled).toBe(false);
    });

    /** A solo Site race (the claim says solo) run to its finale by the host. */
    const ranToFinale = async () => {
      site.answers.set(claimPath, () => ({
        ok: true,
        race: { title: 'Friday race', startsAt, format: 'solo', brand: null },
      }));
      const { host, pin } = await siteRace();
      const hostSeen = record(host);
      const players: SyncedPlayer[] = [];
      const seen: [string, unknown][][] = [];
      for (const n of ['Ann', 'Ben', 'Cat']) {
        const p = await joinAndSync(ctx.h, pin, n);
        players.push(p);
        seen.push(record(p.socket));
      }
      const screen = ctx.h.connect();
      const screenSeen = record(screen);
      await screen.emitWithAck('spectator:join', { pin });
      expect(await screen.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
      const running = players.map((p) => stateWhere(p.socket, (s) => s.phase === 'running'));
      expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
      await Promise.all(running);
      expect(
        await players[0].socket.emitWithAck('escape:submit', {
          pin,
          lockId: 'catalogue',
          input: '42',
        }),
      ).toMatchObject({ ok: true });
      const finales = players.map((p) => nextEvent<EscapeFinale>(p.socket, 'escape:finale'));
      expect(await host.emitWithAck('escape:end', { pin })).toEqual({ ok: true });
      await Promise.all(finales);
      return { pin, players, frames: [hostSeen, screenSeen, ...seen] };
    };

    it('the finale reports the ranking to the Site: names, no player ids; no client sees the race id', async () => {
      const { pin, players, frames } = await ranToFinale();
      const [report] = await eventually(async () => {
        const got = calls(resultsPath);
        if (!got.length) throw new Error('no results yet');
        return got;
      });
      const body = report.body as RaceResults;
      expect(body).toMatchObject({ pin, totalTeams: 3 });
      expect(body.top.map((r) => r.name).sort()).toEqual(['Ann', 'Ben', 'Cat']);
      expect(body.top.map((r) => r.place)).toEqual([1, 2, 3]);
      const text = JSON.stringify(body);
      for (const p of players) expect(text).not.toContain(p.playerId);
      await settle(100);
      for (const f of frames) {
        expect(f.length).toBeGreaterThan(0);
        expect(sessionLeaksIn(f, { siteRaceId: RACE, host: f === frames[0] })).toEqual([]);
      }
    });

    it('the Site failing at the finale: the finale still shows; the report is tried twice', async () => {
      // No answer for results: the stub gives a 404, a failure for the client.
      site.answers.delete(resultsPath);
      const { pin } = await ranToFinale(); // every phone got its finale
      await eventually(async () => {
        if (calls(resultsPath).length < 2) throw new Error('not retried yet');
      });
      expect(calls(resultsPath).every((c) => (c.body as RaceResults).pin === pin)).toBe(true);
    });
  });
}
