import type { EscapeFinale } from '@quiz-dock/contracts';
import type { Socket } from 'socket.io-client';
import { ACME_LICENCE, DEV_LICENCES } from '../../src/escape/licences/dev-licences';
import { lostLibrary } from '../../src/escape/samples';
import { nextEvent, settle } from '../game-harness';
import {
  type EscapeContext,
  type SyncedPlayer,
  createAs,
  extraScreens,
  joinAndSync,
  record,
  seedTemplate,
  stateWhere,
  submitAs,
  useLicences,
} from './escape-harness';
import { codesIn, sessionLeaksIn } from './leaks';

const ACME = { id: ACME_LICENCE.id, organisationId: ACME_LICENCE.organisationId };

/**
 * The session boundary (M7 §1.4, Task 7.20): whole runs recorded on every kind
 * of socket carry no licence detail and no other team's race code.
 */
export function sessionLeakTests(ctx: EscapeContext): void {
  let library: string;

  beforeAll(async () => {
    library = await seedTemplate(ctx.h, lostLibrary);
  });

  beforeEach(() => useLicences(ctx.h, DEV_LICENCES));
  afterEach(() => useLicences(ctx.h));

  const ended = (sockets: Socket[]) =>
    sockets.map((s) => nextEvent<EscapeFinale>(s, 'escape:finale'));

  it('a full Acme run: console, phones, screens and follow copy get no licence detail', async () => {
    const host = ctx.h.connectHost();
    const hostSeen = record(host);
    const { pin } = await createAs(host, ctx.templateId, 'hosted', { licenceId: 'acme' });
    if (!pin) throw new Error('hosted create refused');
    expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    const phones: SyncedPlayer[] = [];
    const seen: [string, unknown][][] = [];
    for (const n of ['Ann', 'Ben', 'Cat', 'Dan']) {
      const p = await joinAndSync(ctx.h, pin, n);
      phones.push(p);
      seen.push(record(p.socket));
    }
    const { own, paired, follow } = await extraScreens(ctx.h, pin, host);
    const screens = [own, paired, follow].map(record);
    expect(await host.emitWithAck('escape:teams', { pin, mode: 'auto', count: 2 })).toEqual({
      ok: true,
    });
    const running = phones.map((p) => stateWhere(p.socket, (s) => s.phase === 'running'));
    expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
    await Promise.all(running);
    await submitAs(phones[0], pin, 'lobby-badge', 'WRONG');
    expect(await host.emitWithAck('escape:hint', { pin })).toMatchObject({ ok: true });
    expect(
      await host.emitWithAck('escape:unlock', { pin, teamId: 't1', lockId: 'lobby-badge' }),
    ).toMatchObject({ ok: true });
    const finales = ended([host, ...phones.map((p) => p.socket)]);
    expect(await host.emitWithAck('escape:end', { pin })).toEqual({ ok: true });
    const [{ gameId }] = await Promise.all(finales);
    await phones[0].socket.emitWithAck('escape:results', {
      gameId,
      sessionToken: phones[0].sessionToken,
    });
    await settle(100);

    for (const frames of [hostSeen, ...seen, ...screens]) {
      expect(frames.length).toBeGreaterThan(0);
      expect(sessionLeaksIn(frames, { licence: ACME })).toEqual([]);
    }
  });

  it('a 3-team race: each phone sees its own code only; the host, screen and board none', async () => {
    const host = ctx.h.connectHost();
    const hostSeen = record(host);
    const { pin } = await createAs(host, library, 'race', { race: { format: 'teams' } });
    if (!pin) throw new Error('race refused');
    expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    const names = ['Ann', 'Ben', 'Cat', 'Dan', 'Eve', 'Fay', 'Gus'];
    const phones = await Promise.all(names.map((n) => joinAndSync(ctx.h, pin, n)));
    const seen = phones.map((p) => record(p.socket));
    const screen = ctx.h.connect();
    await screen.emitWithAck('spectator:join', { pin });
    expect(await screen.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    const board = ctx.h.connect();
    await board.emitWithAck('spectator:join', { pin, follow: true });
    expect(await board.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    const screens = [screen, board].map(record);

    // Three teams by code: A+D, B+E, C+F; G stays solo until the start.
    const codes: string[] = [];
    for (const [i, name] of ['Owls', 'Bats', 'Cats'].entries()) {
      const team = (await phones[i].socket.emitWithAck('escape:new-team', { pin, name })) as {
        code: string;
      };
      codes.push(team.code);
      expect(
        await phones[i + 3].socket.emitWithAck('escape:join-team', { pin, code: team.code }),
      ).toMatchObject({ ok: true });
    }
    const running = phones.map((p) => stateWhere(p.socket, (s) => s.phase === 'running'));
    expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
    await Promise.all(running);
    await submitAs(phones[0], pin, 'catalogue', '42');
    await submitAs(phones[1], pin, 'catalogue', '0');
    const finales = ended([host, ...phones.map((p) => p.socket)]);
    expect(await host.emitWithAck('escape:end', { pin })).toEqual({ ok: true });
    await Promise.all(finales);
    await settle(100);

    const ownCodes = [0, 1, 2, 0, 1, 2].map((i) => [codes[i]]).concat([[]]);
    seen.forEach((frames, i) => {
      // Not vacuous: a phone in a team was sent its code.
      if (i < 6)
        expect(codesIn(frames.filter(([e]) => e === 'escape:state'))).toContain(codes[i % 3]);
      expect(sessionLeaksIn(frames, { ownCodes: ownCodes[i] })).toEqual([]);
    });
    for (const frames of [hostSeen, ...screens]) {
      expect(frames.length).toBeGreaterThan(0);
      expect(sessionLeaksIn(frames)).toEqual([]);
    }
  });

  it('sessionLeaksIn finds the leaks it is meant to', () => {
    expect(
      sessionLeaksIn(
        [
          ['escape:state', { team: { code: 'ABCD' }, x: { eventsLeft: 1 } }],
          ['escape:host', { session: { licence: { organisationName: 'acme-org' } } }],
          ['exception', { code: 'escape.team_full' }],
          ['escape:board', { race: { siteRaceId: 'r-1' }, note: 'r-1' }],
        ],
        { licence: ACME, siteRaceId: 'r-1' },
      ),
    ).toEqual([
      'escape:state $.x.eventsLeft: a licence detail',
      "escape:state: another team's code ABCD",
      'escape:host $.session.licence.organisationName: the organisation id',
      'escape:board $.race.siteRaceId: a licence detail',
      'escape:board $.race.siteRaceId: the Site race id',
      'escape:board $.note: the Site race id',
    ]);
  });
}
