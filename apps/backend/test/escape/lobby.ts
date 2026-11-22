import {
  type EscapeBoard,
  type EscapeHostState,
  type EscapeOutline,
  type EscapePlayerState,
  GameState,
} from '@quiz-dock/contracts';
import type { Socket } from 'socket.io-client';
import { vaultHeist } from '../../src/escape/samples';
import { GameService } from '../../src/game/game.service';
import { nextEvent } from '../game-harness';
import {
  type EscapeContext,
  type SyncedPlayer,
  createEscape,
  eventually,
  joinAndSync,
  record,
  seedTemplate,
  stateWhere,
} from './escape-harness';
import { leaksIn } from './leaks';

/** Opening a run, syncing every kind of socket, forming teams and starting (Task 3.9). */
export function lobbyTests(ctx: EscapeContext): void {
  /** A synced host console on a new escape room of Vault Heist, and `n` synced players. */
  async function room(n: number) {
    const host = ctx.h.connectHost();
    const pin = await createEscape(host, ctx.templateId);
    const hostStates: EscapeHostState[] = [];
    host.on('escape:host', (s: EscapeHostState) => hostStates.push(s));
    expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    const players: SyncedPlayer[] = [];
    for (let i = 0; i < n; i++) players.push(await joinAndSync(ctx.h, pin, `P${i}`));
    const lastHost = () => hostStates.at(-1)!;
    return { host, pin, players, hostStates, lastHost };
  }

  /**
   * The host's view once `event` is acked (it must be ok): the last one in by
   * then, as the command's own view goes out on the same socket before its ack.
   */
  async function hostAfter(host: Socket, event: string, payload: object): Promise<EscapeHostState> {
    const got: EscapeHostState[] = [];
    const keep = (s: EscapeHostState) => got.push(s);
    host.on('escape:host', keep);
    expect(await host.emitWithAck(event, payload)).toEqual({ ok: true });
    host.off('escape:host', keep);
    const last = got.at(-1);
    if (!last) throw new Error(`no escape:host after ${event}`);
    return last;
  }

  const membersOf = (s: EscapeHostState) => s.teams.map((t) => t.members.map((m) => m.nickname));

  const phoneLeaks = (seen: [string, unknown][]) =>
    seen.flatMap(([event, p]) =>
      event === 'escape:state'
        ? leaksIn(p, ctx.vault, { roles: (p as EscapePlayerState).view?.roles ?? [] })
        : leaksIn(p, ctx.vault),
    );

  it('escape:create gives a PIN; the host console gets the outline, its view and the board', async () => {
    const host = ctx.h.connectHost();
    const pin = await createEscape(host, ctx.templateId);
    expect(pin).toMatch(/^\d{6}$/);
    const outline = nextEvent<EscapeOutline>(host, 'escape:outline');
    const view = nextEvent<EscapeHostState>(host, 'escape:host');
    const board = nextEvent<EscapeBoard>(host, 'escape:board');
    expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    const o = await outline;
    expect(o.templateId).toBe(ctx.templateId);
    expect(o.version).toBe(1);
    // The answers, to the host console only.
    expect(o.template.stages[0].locks[0]).toMatchObject({ kind: 'code', answer: '0417' });
    expect(await view).toMatchObject({ teams: [], unassigned: [], templateVersion: 1 });
    expect(await board).toMatchObject({ phase: 'forming', title: 'Vault Heist', teams: [] });
  });

  it('refuses a guest, and a signed-in user without the host role', async () => {
    const guest = ctx.h.connect();
    expect(await guest.emitWithAck('escape:create', { templateId: ctx.templateId })).toMatchObject({
      ok: false,
      error: { code: 'host.auth_required' },
    });
    const other = ctx.h.connect({ localUser: 'Not a host' });
    expect(await other.emitWithAck('escape:create', { templateId: ctx.templateId })).toMatchObject({
      ok: false,
      error: { code: 'auth.host_required' },
    });
  });

  it('refuses an unknown template, an unfinishable draft and a bad payload', async () => {
    const host = ctx.h.connectHost();
    expect(await host.emitWithAck('escape:create', { templateId: 'nope' })).toMatchObject({
      ok: false,
      error: { code: 'escape_template.not_found' },
    });
    const draft = await seedTemplate(
      ctx.h,
      { ...vaultHeist, title: 'Too short', stages: vaultHeist.stages.slice(0, 1) },
      'draft',
    );
    expect(await host.emitWithAck('escape:create', { templateId: draft })).toMatchObject({
      ok: false,
      error: { code: 'escape_template.invalid' },
    });
    expect(await host.emitWithAck('escape:create', { templateId: 42 })).toMatchObject({
      ok: false,
      error: { code: 'validation' },
    });
  });

  it('a valid draft opens (for testing it)', async () => {
    const draft = await seedTemplate(ctx.h, { ...vaultHeist, title: 'Draft heist' }, 'draft');
    const host = ctx.h.connectHost();
    expect(await createEscape(host, draft)).toMatch(/^\d{6}$/);
  });

  it('six players join and sync: each gets its state, with no team', async () => {
    const { pin, players, lastHost } = await room(6);
    const meta = await ctx.h.app.get(GameService).getMeta(pin);
    for (const p of players) {
      expect(p.last()).toMatchObject({ phase: 'forming', team: null, view: null, nextHint: null });
      expect(p.last().title).toBe('Vault Heist');
      // The run's id: the key for escape:results, and how a phone sees a new game.
      expect(p.last().gameId).toBe(meta!.id);
    }
    // The host's view follows the arrivals (its sync came first).
    await eventually(async () => expect(lastHost().unassigned).toHaveLength(6));
    expect(lastHost().unassigned.map((u) => u.nickname)).toEqual([
      'P0',
      'P1',
      'P2',
      'P3',
      'P4',
      'P5',
    ]);
  });

  it('auto teams deal the connected players in join order: 3 and 3', async () => {
    const { host, pin, players } = await room(6);
    const seen = players.map((p) => record(p.socket));
    const states = players.map((p) => stateWhere(p.socket, (s) => s.team !== null));
    const view = await hostAfter(host, 'escape:teams', { pin, mode: 'auto', count: 2 });
    expect(view.teams.map((t) => t.name)).toEqual(['Team 1', 'Team 2']);
    expect(membersOf(view)).toEqual([
      ['P0', 'P2', 'P4'],
      ['P1', 'P3', 'P5'],
    ]);
    expect(view.unassigned).toEqual([]);
    const got = await Promise.all(states);
    expect(got.map((s) => s.team!.id)).toEqual(['t1', 't2', 't1', 't2', 't1', 't2']);
    expect(got[0].team!.members).toHaveLength(3);
    expect(got[0].view).toBeNull(); // nothing of the game before the start
    expect(phoneLeaks(seen.flat())).toEqual([]);
  });

  it('auto teams take names when given', async () => {
    const { host, pin } = await room(1);
    const view = await hostAfter(host, 'escape:teams', {
      pin,
      mode: 'auto',
      count: 2,
      names: ['Foxes', 'Owls'],
    });
    expect(view.teams.map((t) => t.name)).toEqual(['Foxes', 'Owls']);
  });

  it('self mode with maxSize 1: the second chooser of a team gets escape.team_full', async () => {
    const { host, pin, players } = await room(2);
    const view = await hostAfter(host, 'escape:teams', { pin, mode: 'self', count: 2, maxSize: 1 });
    expect(view.formation).toMatchObject({ mode: 'self', maxSize: 1 });
    expect(membersOf(view)).toEqual([[], []]);
    const [a, b] = players;
    const chosen = stateWhere(a.socket, (s) => s.team?.id === 't1');
    expect(await a.socket.emitWithAck('escape:choose-team', { pin, teamId: 't1' })).toEqual({
      ok: true,
    });
    expect((await chosen).formation.teams[0].memberCount).toBe(1);
    expect(await b.socket.emitWithAck('escape:choose-team', { pin, teamId: 't1' })).toMatchObject({
      ok: false,
      error: { code: 'escape.team_full' },
    });
    expect(await b.socket.emitWithAck('escape:choose-team', { pin, teamId: 'zz' })).toMatchObject({
      ok: false,
      error: { code: 'escape.team_not_found' },
    });
    // A player may change their mind while forming.
    expect(await a.socket.emitWithAck('escape:choose-team', { pin, teamId: 't2' })).toEqual({
      ok: true,
    });
    expect(await b.socket.emitWithAck('escape:choose-team', { pin, teamId: 't1' })).toEqual({
      ok: true,
    });
  });

  it('choosing a team outside self mode gives escape.self_select_closed', async () => {
    const { host, pin, players } = await room(1);
    await hostAfter(host, 'escape:teams', { pin, mode: 'auto', count: 2 });
    expect(
      await players[0].socket.emitWithAck('escape:choose-team', { pin, teamId: 't2' }),
    ).toMatchObject({ ok: false, error: { code: 'escape.self_select_closed' } });
  });

  it('escape:move updates both teams; unknown players and teams are refused', async () => {
    const { host, pin, players } = await room(4);
    await hostAfter(host, 'escape:teams', { pin, mode: 'auto', count: 2 });
    const moved = stateWhere(players[0].socket, (s) => s.team?.id === 't2');
    const view = await hostAfter(host, 'escape:move', {
      pin,
      playerId: players[0].playerId,
      teamId: 't2',
    });
    expect(membersOf(view)).toEqual([['P2'], ['P1', 'P3', 'P0']]);
    expect((await moved).team!.members.map((m) => m.nickname)).toEqual(['P1', 'P3', 'P0']);

    const out = await hostAfter(host, 'escape:move', {
      pin,
      playerId: players[1].playerId,
      teamId: null,
    });
    expect(membersOf(out)).toEqual([['P2'], ['P3', 'P0']]);
    expect(out.unassigned.map((u) => u.nickname)).toEqual(['P1']);

    expect(
      await host.emitWithAck('escape:move', { pin, playerId: 'ghost', teamId: 't1' }),
    ).toMatchObject({ ok: false, error: { code: 'escape.player_not_found' } });
    expect(
      await host.emitWithAck('escape:move', { pin, playerId: players[2].playerId, teamId: 'zz' }),
    ).toMatchObject({ ok: false, error: { code: 'escape.team_not_found' } });
    // Host commands are the room's host's only.
    expect(
      await players[2].socket.emitWithAck('escape:move', {
        pin,
        playerId: players[2].playerId,
        teamId: 't2',
      }),
    ).toMatchObject({ ok: false, error: { code: 'host.auth_required' } });
  });

  it('escape:start: running, stage 0 on every phone, one role each; the screen gets the board', async () => {
    const { host, pin, players } = await room(6);
    const screen = ctx.h.connect();
    expect(await screen.emitWithAck('spectator:join', { pin })).toBeDefined();
    const boards: EscapeBoard[] = [];
    screen.on('escape:board', (b: EscapeBoard) => boards.push(b));
    expect(await screen.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    const seen = [...players.map((p) => record(p.socket)), record(screen)];

    await hostAfter(host, 'escape:teams', { pin, mode: 'auto', count: 2 });
    const running = players.map((p) => stateWhere(p.socket, (s) => s.phase === 'running'));
    const gameState = nextEvent<{ state: string }>(players[0].socket, 'game:state');
    const view = await hostAfter(host, 'escape:start', { pin });
    expect(view.board.phase).toBe('running');
    expect((await gameState).state).toBe(GameState.Escape);

    const got = await Promise.all(running);
    for (const s of got) {
      expect(s.view?.stageIndex).toBe(0);
      expect(s.view?.roles).toHaveLength(1);
      expect(s.team?.deadlineAt).toBeGreaterThan(Date.now());
    }
    for (const team of ['t1', 't2']) {
      const roles = got.filter((s) => s.team!.id === team).map((s) => s.view!.roles[0]);
      expect(new Set(roles).size).toBe(3);
    }
    await nextEvent<EscapeBoard>(screen, 'escape:board', { where: (b) => b.phase === 'running' });
    expect(phoneLeaks(seen.flat())).toEqual([]);
    // Screens and phones never get the host's events.
    const hostOnly = new Set(['escape:outline', 'escape:host', 'escape:host-team']);
    expect(seen.flat().filter(([e]) => hostOnly.has(e))).toEqual([]);

    expect(await host.emitWithAck('escape:start', { pin })).toMatchObject({
      ok: false,
      error: { code: 'escape.wrong_phase' },
    });
  });

  it('escape:start without a team that has a member gives escape.no_players', async () => {
    const { host, pin } = await room(0);
    await hostAfter(host, 'escape:teams', { pin, mode: 'self', count: 2 });
    expect(await host.emitWithAck('escape:start', { pin })).toMatchObject({
      ok: false,
      error: { code: 'escape.no_players' },
    });
  });

  it('escape:start drops empty teams and places the unassigned in the smallest', async () => {
    const { host, pin, players } = await room(3);
    await hostAfter(host, 'escape:teams', { pin, mode: 'self', count: 3 });
    expect(
      await players[0].socket.emitWithAck('escape:choose-team', { pin, teamId: 't2' }),
    ).toEqual({ ok: true });
    const view = await hostAfter(host, 'escape:start', { pin });
    expect(view.teams.map((t) => t.id)).toEqual(['t2']);
    expect(membersOf(view)).toEqual([['P0', 'P1', 'P2']]);
  });

  it('escape:start deals the roles afresh: players who picked a team one by one get one each', async () => {
    const { host, pin, players } = await room(3);
    await hostAfter(host, 'escape:teams', { pin, mode: 'self', count: 1 });
    // The first to pick held every role in the lobby; the others would only share one.
    for (const p of players) {
      expect(await p.socket.emitWithAck('escape:choose-team', { pin, teamId: 't1' })).toEqual({
        ok: true,
      });
    }
    const running = players.map((p) => stateWhere(p.socket, (s) => s.phase === 'running'));
    await hostAfter(host, 'escape:start', { pin });
    const got = await Promise.all(running);
    for (const s of got) expect(s.view?.roles).toHaveLength(1);
    expect(new Set(got.map((s) => s.view!.roles[0])).size).toBe(3);
  });

  it('a late joiner in auto formation lands in the smallest team at its first sync', async () => {
    const { host, pin } = await room(3);
    await hostAfter(host, 'escape:teams', { pin, mode: 'auto', count: 2 });
    await hostAfter(host, 'escape:start', { pin });
    const update = nextEvent<EscapeHostState>(host, 'escape:host');
    const late = await joinAndSync(ctx.h, pin, 'Late');
    expect(late.last()).toMatchObject({ phase: 'running', team: { id: 't2' } });
    expect(late.last().view?.stageIndex).toBe(0);
    expect(late.last().view?.roles.length).toBeGreaterThan(0);
    expect(membersOf(await update)[1]).toEqual(['P1', 'Late']);
    expect(leaksIn(late.last(), ctx.vault, { roles: late.last().view!.roles })).toEqual([]);
  });

  it('host:start on an escape lobby gives session.quiz_required', async () => {
    const { host, pin } = await room(1);
    expect(await host.emitWithAck('host:start', { pin })).toMatchObject({
      ok: false,
      error: { code: 'session.quiz_required' },
    });
  });

  it('escape:open from a room that played a quiz: its players are unassigned and get their state', async () => {
    const host = ctx.h.connectHost();
    const quiz = await ctx.h.seedQuiz();
    const pin = await ctx.h.createGame(host, quiz.id);
    const a = await ctx.h.join(pin, 'Ann');
    const b = await ctx.h.join(pin, 'Bob');
    const states = [a, b].map((p) => stateWhere(p.socket, (s) => s.phase === 'forming'));
    const lobby = nextEvent<{ state: string }>(a.socket, 'game:state');
    expect(
      await host.emitWithAck('escape:open', { pin, templateId: ctx.templateId, durationMin: 30 }),
    ).toEqual({ ok: true });
    for (const s of await Promise.all(states)) {
      expect(s.team).toBeNull();
      expect(s.clock.limitMs).toBe(30 * 60_000);
    }
    expect((await lobby).state).toBe(GameState.Lobby);

    // The host's console syncs and sees both, unassigned.
    const view = nextEvent<EscapeHostState>(host, 'escape:host');
    expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    expect((await view).unassigned.map((u) => u.nickname)).toEqual(['Ann', 'Bob']);

    // Not from a running run.
    await hostAfter(host, 'escape:teams', { pin, mode: 'auto', count: 1 });
    await hostAfter(host, 'escape:start', { pin });
    expect(
      await host.emitWithAck('escape:open', { pin, templateId: ctx.templateId }),
    ).toMatchObject({ ok: false, error: { code: 'session.next_quiz_from_lobby' } });
  });

  it('escape events on a quiz game give escape.not_found', async () => {
    const host = ctx.h.connectHost();
    const pin = await ctx.h.createGame(host, (await ctx.h.seedQuiz()).id);
    expect(await host.emitWithAck('escape:sync', { pin })).toMatchObject({
      ok: false,
      error: { code: 'escape.not_found' },
    });
  });

  it("turns away a browser's handshake from another site with the escape gateway too", async () => {
    const outcome = (socket: Socket) =>
      new Promise<'connected' | 'refused'>((resolve) => {
        socket.once('connect', () => resolve('connected'));
        socket.once('connect_error', () => resolve('refused'));
      });
    const foreign = ctx.h.connect(undefined, { origin: 'https://elsewhere.example' });
    expect(await outcome(foreign)).toBe('refused');
    const own = ctx.h.connect(
      { localUser: 'Animateur' },
      { origin: `http://127.0.0.1:${ctx.h.port}` },
    );
    expect(await outcome(own)).toBe('connected');
    expect(await createEscape(own, ctx.templateId)).toMatch(/^\d{6}$/);
  });
}
