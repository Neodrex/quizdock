import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  type ClientToServerEvents,
  type EscapeAdjustTime,
  type EscapeAnnounce,
  type EscapeAskHint,
  type EscapeAskHintAck,
  type EscapeCreate,
  type EscapeFinale,
  type EscapeMove,
  type EscapeOpen,
  type EscapeRefusal,
  type EscapeResults,
  type EscapeSubmit,
  type EscapeSubmitAck,
  type EscapeTeams,
  type EscapeTeamUpdate,
  type EscapeTool,
  type EscapeUnlock,
  GameState,
  type ServerToClientEvents,
} from '@quiz-dock/contracts';
import type { Server, Socket } from 'socket.io';
import { GameEngine } from '../game/game.engine';
import { playerOf, type GameSocketData } from '../game/game.gateway';
import { gameHash } from '../game/game-hash';
import { ROOM_HASH_KEY, gameKeys, type GameId } from '../game/game.keys';
import { GameService } from '../game/game.service';
import type { GameMeta } from '../game/game.types';
import { RedisService } from '../redis/redis.service';
import { EscapeAttempts } from './escape-attempts';
import { endClock, isTimedOut, pauseClock, resumeClock, runElapsed } from './escape-clock';
import type {
  EscapeRun,
  EscapeSession,
  EscapeSnapshot,
  FrozenLicence,
  TeamRecord,
} from './escape-live.types';
import {
  RACE_LEAD_SLACK_MS,
  RACE_MAX_LEAD_MIN,
  SESSION_RULES,
  capOf,
  limitsOf,
  modeAllowed,
  toolAllowed,
} from './escape-session';
import {
  announceOf,
  boardOf,
  finaleOf,
  hintUpdateOf,
  hostStateOf,
  hostTeamOf,
  hostOutlineOf,
  lookOf,
  playerStateOf,
  finaleFor,
  type RunView,
  screenFinaleOf,
  submitUpdateOf,
  timeUpOf,
  viewLimits,
} from './escape-payloads';
import { adjustTime, hostUnlock, newTeam, nextHint, submit, useHint } from './escape-rules';
import { allDone, tickTeam } from './escape-tick';
import { EscapeScheduler } from './escape-scheduler';
import { EscapeTicker } from './escape-ticker';
import { validateTemplate } from './escape-template';
import { EscapeTemplatesService } from './escape-templates.service';
import {
  dealPlayers,
  makeTeams,
  moveMember,
  nextTeamId,
  rolesFor,
  smallestTeam,
  teamOf,
} from './escape-teams';
import { RACE_TEAM_MAX, newCode, normaliseCode } from './race-codes';
import { EscapeTimings } from './escape-timings';
import { escapeRooms } from './escape.keys';
import { EscapeStore } from './escape.store';
import type { TeamState } from './escape.types';
import { LICENCE_REQUIRED, licenceErrorCode } from './licences/licence-errors';
import {
  LICENCE_PORT,
  type Licence,
  type LicenceHost,
  type LicencePort,
} from './licences/licence.port';
import { SerialQueue } from './serial-queue';

type EscapeServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  GameSocketData
>;
export type EscapeSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  GameSocketData
>;
/** A socket as `fetchSockets` gives it: what both kinds share. */
type AnySocket = Pick<EscapeSocket, 'data' | 'rooms' | 'join' | 'leave' | 'emit'>;

/** The run a command acts on: the room's current game, an escape game. */
interface RunRef {
  pin: string;
  id: GameId;
  meta: GameMeta;
  snap: EscapeSnapshot;
  run: EscapeRun;
}

const TEAM_ROOM_PREFIX = 'escape:';

/**
 * The run's host console: a host control of the room, signed in as its host,
 * that never joined as a spectator. One that did is a screen (M6 §1.4).
 */
function isHostConsole(d: GameSocketData, pin: string, hostUserId: string): boolean {
  return (
    d.isHostControl === true &&
    d.pin === pin &&
    d.projection === undefined &&
    d.user?.id === hostUserId
  );
}

/** What a hosted room keeps of its licence: never its uses, nor who may use it. */
const frozen = (l: Licence): FrozenLicence => ({
  id: l.id,
  organisationId: l.organisationId,
  participantCap: l.participantCap,
  expiresAt: l.expiresAt,
  package: l.package,
  brand: l.brand ? { ...l.brand } : null,
});

const fresh = (team: TeamState, code?: string): TeamRecord => ({
  team,
  lastProgressAt: 0,
  stuck: false,
  timedOut: false,
  ...(code ? { code } : {}),
});

/** A race team's name: the nickname, within the team name's 40 characters. */
const soloName = (nickname: string): string => nickname.slice(0, 40) || 'Solo';

/** The same roles per member, whatever the key and role order. */
function sameRoles(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
  const flat = (r: Record<string, string[]>) =>
    Object.entries(r)
      .map(([m, rs]) => `${m}:${[...rs].sort().join(',')}`)
      .sort()
      .join(';');
  return flat(a) === flat(b);
}

/**
 * F4: the team's roles in `phase`. In the lobby they are dealt afresh (round
 * robin), so a phone's role card is a live preview of what escape:start deals;
 * once running they are sticky, so a reconnect or move keeps the others' roles.
 */
const dealRoles = (
  tpl: EscapeSnapshot['template'],
  team: TeamState,
  live: ReadonlySet<string>,
  phase: EscapeRun['phase'],
): Record<string, string[]> =>
  rolesFor(tpl, phase === 'forming' ? { ...team, roles: {} } : team, live);

const membersIndex = (teams: TeamState[]): Record<string, string> =>
  Object.fromEntries(teams.flatMap((t) => t.members.map((m) => [m, t.id])));

/**
 * The live loop of an escape run (M3 plan §3). The M1 rules decide; this adds
 * storage, transport and order: every mutation of a run goes through one
 * SerialQueue keyed by its game id (mono-instance, as quizdock's own engine).
 * Every phone payload is built by escape-payloads, so `view` is always
 * playerView's.
 */
@Injectable()
export class EscapeEngine implements OnModuleDestroy {
  private readonly log = new Logger(EscapeEngine.name);
  private server!: EscapeServer;
  private readonly queue = new SerialQueue();
  /** One ticker per running run, keyed by game id (timed hints, time-up, stuck). */
  private readonly ticker = new EscapeTicker(this.log);
  /** Scheduled race starts, by PIN (M7 §1.7); re-armed by recover() after a restart. */
  private readonly scheduler = new EscapeScheduler(this.log);
  /**
   * Board throttle per room: present while a board went out less than
   * `boardEveryMs` ago; `pending` when another was asked for meanwhile. An
   * entry removes itself once idle, so nothing stays behind a room.
   */
  private readonly boards = new Map<
    string,
    { pending: boolean; host: boolean; timer: NodeJS.Timeout }
  >();
  /**
   * R1/R2: when each player of a run lost their last socket (epoch ms), by
   * game id. In process, like the tickers: after a restart, members without a
   * socket count as gone since boot (R4).
   */
  private readonly gone = new Map<GameId, Map<string, number>>();
  /** When the ticker last gave a run's keys their TTL again, by game id. */
  private readonly touched = new Map<GameId, number>();
  private readonly bootAt = Date.now();

  constructor(
    private readonly game: GameService,
    private readonly store: EscapeStore,
    private readonly templates: EscapeTemplatesService,
    private readonly timings: EscapeTimings,
    private readonly redis: RedisService,
    private readonly attempts: EscapeAttempts,
    private readonly modules: ModuleRef,
    @Inject(LICENCE_PORT) private readonly licences: LicencePort,
  ) {}

  bindServer(server: EscapeServer): void {
    this.server = server;
    // E3: before a room ends under its run (host:end, the host window), the finale goes out.
    this.modules.get(GameEngine, { strict: false }).beforeEnd = (ref) =>
      this.closing(ref.pin, ref.id);
    this.recover().catch((err: Error) => this.log.error(`recover: ${err.message}`));
  }

  onModuleDestroy(): void {
    this.ticker.stopAll();
    this.scheduler.stopAll();
    for (const b of this.boards.values()) clearTimeout(b.timer);
    this.boards.clear();
  }

  /**
   * What this process keeps for a run and its room (tests check that nothing stays).
   * @internal test seam
   */
  inProcess(
    id: GameId,
    pin: string,
  ): { ticking: boolean; gone: boolean; board: boolean; scheduled: boolean } {
    return {
      ticking: this.ticker.has(id),
      gone: this.gone.has(id),
      board: this.boards.has(pin),
      scheduled: this.scheduler.has(pin),
    };
  }

  /**
   * V1: tickers live in this process. After a restart, every escape run still
   * running gets its ticker again, from Redis (as GameEngine.recoverTimers),
   * and every race still waiting for its scheduled start its timer (M7 §1.7).
   */
  private async recover(): Promise<void> {
    for (const key of await this.redis.scanKeys(gameKeys.room('*'))) {
      if (!ROOM_HASH_KEY.test(key)) continue;
      const pin = key.slice('room:'.length);
      // One room that cannot be read (a corrupt record) must not stop the others.
      try {
        await this.recoverRoom(pin);
      } catch (err) {
        this.log.warn(`recover ${pin}: ${(err as Error).message}`);
      }
    }
  }

  private async recoverRoom(pin: string): Promise<void> {
    const meta = await this.game.getMeta(pin);
    if (meta?.kind !== 'escape') return;
    const run = await this.store.run(meta.id);
    if (run?.phase === 'forming') {
      const race = (await this.store.session(pin))?.race;
      if (race?.startsAt && !race.started) this.armRace(pin, race.startsAt);
      return;
    }
    if (run?.phase !== 'running') return;
    // R4: every member counts as gone since boot until they sync again.
    this.gone.set(meta.id, new Map());
    this.startTicker(pin, meta.id);
  }

  // ── Open (O1–O4) ──

  /**
   * O1: a new room whose first game is this run, forming. Returns the PIN.
   * The session type is checked first (M7 §1.1): nothing is opened on a refusal.
   */
  async create(host: LicenceHost, dto: EscapeCreate): Promise<string> {
    const hostUserId = host.userId;
    const type = dto.sessionType ?? 'hosted';
    const snap = await this.freeze(hostUserId, dto.templateId, type);
    const session = await this.newSession(host, type, dto);
    const { pin } = await this.game.createSession(
      hostUserId,
      {
        pickOwnName: dto.pickOwnName,
        personalTracking: dto.personalTracking,
        participantAccess: dto.participantAccess,
      },
      { empty: true },
    );
    const meta = await this.game.getMeta(pin);
    if (!meta) throw new NotFoundException('session.not_found');
    await this.openOn(pin, meta.id, hostUserId, snap, dto.durationMin, session);
    if (session.race?.startsAt) this.armRace(pin, session.race.startsAt);
    return pin;
  }

  /** O2: a run as the room's next game, from its lobby; the room's players unassigned. */
  async open(pin: string, host: LicenceHost, dto: EscapeOpen): Promise<void> {
    const hostUserId = host.userId;
    const first = await this.requireHostMeta(pin, hostUserId);
    await this.queue.run(first.id, async () => {
      const meta = await this.requireHostMeta(pin, hostUserId);
      if (meta.state !== GameState.Lobby) {
        throw new BadRequestException('session.next_quiz_from_lobby');
      }
      // The room keeps its session (a licence id is then ignored); a quiz room gets
      // a hosted one, under the licence named or the host's only usable one.
      const kept = await this.store.session(pin);
      // A race opened again before its startsAt keeps its timer (armed per PIN), so
      // the scheduled time starts the new template's run.
      const snap = await this.freeze(hostUserId, dto.templateId, kept?.type ?? 'hosted');
      const session = kept
        ? undefined
        : await this.newSession(host, 'hosted', { licenceId: dto.licenceId });
      const id = await this.game.openGameWith(pin, null);
      await this.openOn(pin, id, hostUserId, snap, dto.durationMin, session);
      this.server
        .to(pin)
        .emit('game:state', { state: GameState.Lobby, questionIndex: -1, totalQuestions: 0 });
      // A quiz room turned hosted: its clients follow the new run without a sync,
      // so the look goes to the whole room now (M7 §1.9).
      if (session) this.server.to(pin).emit('escape:look', lookOf(session));
      const ref = await this.requireRun(pin);
      await this.broadcast(ref, await this.viewOf(ref));
    });
  }

  // ── Sync (§2 routing) ──

  /** The socket joins its escape rooms and gets its view: host console, phone or screen. */
  async sync(socket: EscapeSocket, pin: string): Promise<void> {
    let due = false;
    await this.mutate(pin, undefined, async (ref) => {
      const { data } = socket;
      const hostConsole = isHostConsole(data, pin, ref.meta.hostUserId);
      const me = playerOf(socket, pin);
      // M7 §1.9: the room's look, once per sync, before anything it colours.
      if (hostConsole || me) {
        socket.emit('escape:look', lookOf(await this.store.session(pin)));
      }
      if (hostConsole) {
        await socket.join(escapeRooms.host(pin));
        const v = await this.viewOf(ref);
        socket.emit('escape:outline', hostOutlineOf(ref.snap, ref.id));
        socket.emit('escape:host', hostStateOf(v));
        socket.emit('escape:board', boardOf(v));
        // M7 §1.7: a race whose start was missed (the host away then) starts now.
        due = this.startDue(v);
      }
      // Group play (M7 §1.8): a host console that also joined as a player gets its phone state too.
      if (me) {
        const v = await this.viewOf(ref);
        const race = v.session?.type === 'race';
        // M7 §1.7: in a solo race, a player's first sync gives them their own team.
        const solo =
          race &&
          v.session?.race?.format === 'solo' &&
          ref.run.phase !== 'finale' &&
          !teamOf(this.teamsOf(v), me.playerId);
        if (solo) {
          const nickname = v.players.find((p) => p.playerId === me.playerId)?.nickname ?? '';
          const { ref: next, v: added } = await this.addTeam(ref, v, soloName(nickname));
          const moved = await this.applyMove(next, added, me.playerId, added.run.teamIds.at(-1)!);
          await this.broadcast(next, moved, this.formationPhones(v, moved, me.playerId));
          return;
        }
        // M7 §1.8: group play forms one team of everyone by default, so the phone host
        // can start without the console: in the lobby (auto formation), a phone's sync
        // deals it into the smallest team, the first one making "Team 1".
        // Accepted (plan §5): the deal runs on every sync of an unassigned phone, so a
        // host's move of a player to no team is undone on that phone's next sync (a
        // reconnect, a reload); and when every team is full (`maxSize`), no team is
        // added here: the phone stays unassigned until the host makes room or a team.
        const grouped =
          v.session?.type === 'group' &&
          ref.run.phase === 'forming' &&
          ref.run.formation === 'auto' &&
          !teamOf(this.teamsOf(v), me.playerId);
        if (grouped) {
          const made = ref.run.teamIds.length
            ? { ref, v }
            : await this.addTeam(ref, v, makeTeams(1)[0].name);
          const to = smallestTeam(this.teamsOf(made.v), made.ref.run.maxSize);
          if (to) {
            await this.broadcast(
              made.ref,
              await this.applyMove(made.ref, made.v, me.playerId, to.id),
            );
            return;
          }
        }
        // F5: a late joiner in auto formation goes to the smallest team (never in a race).
        const late =
          !race &&
          ref.run.phase === 'running' &&
          ref.run.formation === 'auto' &&
          !teamOf(this.teamsOf(v), me.playerId);
        const to = late ? smallestTeam(this.teamsOf(v), ref.run.maxSize) : null;
        if (to) {
          await this.broadcast(ref, await this.applyMove(ref, v, me.playerId, to.id));
          return;
        }
        // R3: back; their team's roles at once (a returning member shares one).
        this.gone.get(ref.id)?.delete(me.playerId);
        const team = teamOf(this.teamsOf(v), me.playerId);
        if (team && (await this.reconcileRoles(ref, v, [team.id]))) return;
        this.placeInTeamRoom(socket, ref.id, v, me.playerId);
        socket.emit('escape:state', playerStateOf(v, me.playerId));
        // The host sees who is here, and so do the screens (the lobby roster, M6);
        // a finished run's board no longer changes.
        this.toHostAndBoard(ref, v, ref.run.phase !== 'finale');
        return;
      }
      if (hostConsole) return;
      if (!socket.rooms.has(pin)) throw new ForbiddenException('escape.not_in_room');
      // A console that joined as a spectator is a screen now: out of the host room.
      await socket.leave(escapeRooms.host(pin));
      await socket.join(escapeRooms.board(pin));
      const v = await this.viewOf(ref);
      socket.emit('escape:look', lookOf(v.session));
      socket.emit('escape:board', boardOf(v));
      // M6 §1.6: a screen back in the finale gets the screen finale, never the full one.
      const stored = ref.run.phase === 'finale' ? await this.store.results(ref.id) : null;
      if (stored) socket.emit('escape:screen-finale', screenFinaleOf(stored, v));
    });
    if (due) await this.startRace(pin);
  }

  /**
   * R2: a player's socket left. A stale socket (the player is back on another
   * one, `game.engine.ts` handlePlayerDisconnect) changes nothing. Otherwise
   * the player counts as gone from now: their roles move on the first tick
   * past `roleGraceMs`. The host and the screens see them disconnected.
   */
  async playerGone(pin: string, playerId: string): Promise<void> {
    const meta = await this.game.getMeta(pin);
    if (meta?.kind !== 'escape') return;
    await this.mutate(pin, undefined, async (ref) => {
      // While forming, the lobby roster shows them disconnected (M6); roles move
      // only while the run plays: its ticker clears what is kept here.
      if (ref.run.phase === 'forming') {
        this.toHostAndBoard(ref, await this.viewOf(ref));
        return;
      }
      if (ref.run.phase !== 'running') return;
      const sockets = await this.server.in(pin).fetchSockets();
      if (sockets.some((s) => s.data.pin === pin && s.data.playerId === playerId)) return;
      const gone = this.gone.get(ref.id) ?? new Map<string, number>();
      gone.set(playerId, Date.now());
      this.gone.set(ref.id, gone);
      this.toHostAndBoard(ref, await this.viewOf(ref));
    });
  }

  // ── Formation (F1–F5) ──

  /** F1/F2: new teams t1…tN, dealt (auto) or empty (self). Forming only. */
  async teams(pin: string, hostUserId: string, dto: EscapeTeams): Promise<void> {
    await this.mutate(pin, hostUserId, async (ref) => {
      await this.requireTool(ref, 'teams');
      if (ref.run.phase !== 'forming') throw new BadRequestException('escape.wrong_phase');
      const v = await this.viewOf(ref);
      // M7 §1.1: the session type bounds the formation (group play: 3 teams of 6).
      const bounds = v.session ? SESSION_RULES[v.session.type].formation : null;
      if (
        (bounds?.maxTeams && dto.count > bounds.maxTeams) ||
        (bounds?.maxSize && (dto.maxSize ?? 0) > bounds.maxSize)
      ) {
        throw new BadRequestException('escape.not_in_session');
      }
      const tpl = ref.snap.template;
      let teams = makeTeams(dto.count, dto.names).map((s) => newTeam(tpl, s.id, s.name, []));
      if (dto.mode === 'auto') {
        teams = dealPlayers(
          teams,
          v.players.filter((p) => p.connected).map((p) => p.playerId),
        );
      }
      const live = this.pruneAndGetHolders(ref.id, v);
      const recs = teams.map((t) => fresh({ ...t, roles: dealRoles(tpl, t, live, 'forming') }));
      const run: EscapeRun = {
        ...ref.run,
        formation: dto.mode,
        maxSize: dto.maxSize ?? 0,
        teamIds: recs.map((r) => r.team.id),
      };
      await this.store.save(ref.id, {
        replace: true,
        run,
        teams: recs,
        members: { set: membersIndex(recs.map((r) => r.team)) },
      });
      await this.broadcast({ ...ref, run }, { ...v, run, teams: recs });
    });
  }

  /** F3: the host moves a player (forming or running); null unassigns, forming only. */
  async move(pin: string, hostUserId: string, dto: EscapeMove): Promise<void> {
    await this.mutate(pin, hostUserId, async (ref) => {
      await this.requireTool(ref, 'move');
      const { phase } = ref.run;
      if (phase !== 'forming' && phase !== 'running') {
        throw new BadRequestException('escape.wrong_phase');
      }
      if (dto.teamId === null && phase !== 'forming') {
        throw new BadRequestException('escape.wrong_phase');
      }
      const v = await this.viewOf(ref);
      // M7 §1.1: group play moves a player while forming only.
      if (v.session?.type === 'group' && phase !== 'forming') {
        throw new BadRequestException('escape.wrong_phase');
      }
      if (!v.players.some((p) => p.playerId === dto.playerId)) {
        throw new NotFoundException('escape.player_not_found');
      }
      if (dto.teamId !== null && !ref.run.teamIds.includes(dto.teamId)) {
        throw new NotFoundException('escape.team_not_found');
      }
      await this.broadcast(ref, await this.applyMove(ref, v, dto.playerId, dto.teamId));
    });
  }

  /** F2: a player picks a team in self formation (forming; or unassigned while running, F5). */
  async chooseTeam(socket: EscapeSocket, pin: string, teamId: string): Promise<void> {
    const me = playerOf(socket, pin);
    if (!me) throw new BadRequestException('escape.not_joined');
    await this.mutate(pin, undefined, async (ref) => {
      if (ref.run.formation !== 'self') throw new BadRequestException('escape.self_select_closed');
      const v = await this.viewOf(ref);
      const teams = this.teamsOf(v);
      const mine = teamOf(teams, me.playerId);
      const open = ref.run.phase === 'forming' || (ref.run.phase === 'running' && !mine);
      if (!open) throw new BadRequestException('escape.wrong_phase');
      const to = teams.find((t) => t.id === teamId);
      if (!to) throw new NotFoundException('escape.team_not_found');
      if (mine === to) return;
      if (ref.run.maxSize && to.members.length >= ref.run.maxSize) {
        throw new BadRequestException('escape.team_full');
      }
      await this.broadcast(ref, await this.applyMove(ref, v, me.playerId, teamId));
    });
  }

  /**
   * M7 §1.7: a player of a team race starts a team, with a code for friends,
   * and moves into it. Forming, or running for a player with no team yet.
   */
  async newTeam(
    socket: EscapeSocket,
    pin: string,
    name: string,
  ): Promise<{ teamId: string; code: string }> {
    const me = playerOf(socket, pin);
    if (!me) throw new BadRequestException('escape.not_joined');
    return this.mutate(pin, undefined, async (ref) => {
      const v = await this.viewOf(ref);
      this.requireTeamRace(ref, v, me.playerId);
      // At most a team per player of the cap; a team the player leaves empty makes room.
      const mine = teamOf(this.teamsOf(v), me.playerId);
      const freed = mine?.members.length === 1 ? 1 : 0;
      if (ref.run.teamIds.length - freed >= (v.session?.cap ?? Infinity)) {
        throw new ForbiddenException('session.full');
      }
      const taken = new Set(v.teams.flatMap((r) => (r.code ? [r.code] : [])));
      const code = newCode(taken);
      const { ref: next, v: added } = await this.addTeam(ref, v, name, code);
      const teamId = added.run.teamIds.at(-1)!;
      const moved = await this.applyMove(next, added, me.playerId, teamId);
      const out = await this.dropEmptied(next, moved, mine?.id);
      await this.broadcast(out.ref, out.v, this.formationPhones(v, out.v, me.playerId));
      return { teamId, code };
    });
  }

  /**
   * M7 §1.7: a player of a team race joins a team by its code (at most
   * RACE_TEAM_MAX players). Wrong codes are counted per player: past
   * CODE_ATTEMPTS_MAX in the window, every code is refused until it closes.
   */
  async joinTeam(socket: EscapeSocket, pin: string, input: string): Promise<{ teamId: string }> {
    const me = playerOf(socket, pin);
    if (!me) throw new BadRequestException('escape.not_joined');
    return this.mutate(pin, undefined, async (ref) => {
      const v = await this.viewOf(ref);
      this.requireTeamRace(ref, v, me.playerId);
      if (await this.attempts.codesBlocked(ref.id, me.playerId)) {
        throw new BadRequestException('escape.too_many_codes');
      }
      const code = normaliseCode(input);
      const to = code ? v.teams.find((r) => r.code === code) : undefined;
      if (!to) {
        await this.attempts.countCode(ref.id, me.playerId);
        throw new NotFoundException('escape.team_code_unknown');
      }
      const teamId = to.team.id;
      if (to.team.members.includes(me.playerId)) return { teamId };
      if (to.team.members.length >= RACE_TEAM_MAX) {
        throw new BadRequestException('escape.team_full');
      }
      const left = teamOf(this.teamsOf(v), me.playerId)?.id;
      const moved = await this.applyMove(ref, v, me.playerId, teamId);
      const out = await this.dropEmptied(ref, moved, left);
      await this.broadcast(out.ref, out.v, this.formationPhones(v, out.v, me.playerId));
      return { teamId };
    });
  }

  /** A team race, forming, or running for a player without a team. */
  private requireTeamRace(ref: RunRef, v: RunView, playerId: string): void {
    if (v.session?.type !== 'race' || v.session.race?.format !== 'teams') {
      throw new BadRequestException('escape.not_in_session');
    }
    const mine = teamOf(this.teamsOf(v), playerId);
    const open = ref.run.phase === 'forming' || (ref.run.phase === 'running' && !mine);
    if (!open) throw new BadRequestException('escape.wrong_phase');
  }

  /**
   * M7 §1.7: the race team `teamId` (the one a player just left) is deleted
   * when nobody is left in it: out of the run's teams, its record and its code
   * gone. The run and view after.
   */
  private async dropEmptied(
    ref: RunRef,
    v: RunView,
    teamId: string | undefined,
  ): Promise<{ ref: RunRef; v: RunView }> {
    const rec = v.teams.find((r) => r.team.id === teamId);
    if (!rec || rec.team.members.length) return { ref, v };
    const run: EscapeRun = { ...ref.run, teamIds: ref.run.teamIds.filter((t) => t !== teamId) };
    await this.store.save(ref.id, { run, drop: [rec.team.id] });
    const teams = v.teams.filter((r) => r !== rec);
    return { ref: { ...ref, run }, v: { ...v, run, teams } };
  }

  /** A new empty team at the end of the run (a race's), saved; the run and view with it. */
  private async addTeam(
    ref: RunRef,
    v: RunView,
    name: string,
    code?: string,
  ): Promise<{ ref: RunRef; v: RunView }> {
    const id = nextTeamId(ref.run.teamIds);
    const rec = fresh(newTeam(ref.snap.template, id, name, []), code);
    const run: EscapeRun = { ...ref.run, teamIds: [...ref.run.teamIds, id] };
    await this.store.save(ref.id, { run, teams: [rec] });
    return { ref: { ...ref, run }, v: { ...v, run, teams: [...v.teams, rec] } };
  }

  // ── Start (S1–S3) ──

  async start(pin: string, host: LicenceHost): Promise<void> {
    await this.startRun(pin, host);
  }

  /**
   * M7 §1.7: a race's scheduled start, without a host: the same steps as the
   * host's. Already started (the host's "Start now") changes nothing; with
   * nobody in, the race keeps forming and the host may start it later.
   */
  async startRace(pin: string): Promise<void> {
    const held = await this.startRun(pin, undefined).catch((err: Error) => {
      this.log.warn(`scheduled start ${pin}: ${err.message}`);
      return false;
    });
    // The host is away (its room waits in HOST_DISCONNECTED): try again a little
    // later, until the race starts or the room ends (`closing` disarms it).
    if (held) this.armRace(pin, Date.now() + this.timings.raceRetryMs);
  }

  /** A forming race whose scheduled start is due, not started yet nor found empty. */
  private startDue(v: RunView): boolean {
    const race = v.session?.race;
    return (
      v.run.phase === 'forming' &&
      !!race?.startsAt &&
      !race.started &&
      !race.noPlayers &&
      race.startsAt <= v.now
    );
  }

  private armRace(pin: string, at: number): void {
    this.scheduler.arm(pin, at, {
      fire: () => this.startRace(pin),
      touch: () => this.touchWaiting(pin),
      touchEveryMs: this.timings.raceTouchEveryMs,
    });
  }

  /**
   * M7 Task 7.11: a hosted room not started yet checks its licence again, then
   * records the use (idempotent by the room's id) and stores `licenceUsed` at
   * once, so a start that fails later does not use another event. Fails closed:
   * a refusal, the source unavailable or no host included, refuses the start.
   * The session to start with.
   */
  private async useLicence(
    ref: RunRef,
    v: RunView,
    host: LicenceHost | undefined,
    teams: readonly TeamState[],
  ): Promise<EscapeSession | null> {
    const s = v.session;
    if (s?.type !== 'hosted' || !s.licence || s.licenceUsed) return s;
    if (!host) throw new ForbiddenException(LICENCE_REQUIRED);
    const now = Date.now();
    const checked = await this.licences.check(host, s.licence.id, now);
    if (!checked.ok) throw new ForbiddenException(licenceErrorCode(checked.reason));
    const use = await this.licences.recordUse(s.licence.id, {
      useKey: ref.meta.roomId,
      pin: ref.pin,
      gameId: ref.id,
      startedAt: now,
      players: teams.reduce((n, t) => n + t.members.length, 0),
    });
    if (!use.ok) throw new ForbiddenException(licenceErrorCode(use.reason));
    const used = { ...s, licenceUsed: true };
    await this.store.writeSession(ref.pin, used);
    return used;
  }

  /** A race waiting for its start keeps its room alive. */
  private async touchWaiting(pin: string): Promise<void> {
    const meta = await this.game.getMeta(pin);
    if (meta?.kind === 'escape') await this.keepAlive(pin, meta.id);
  }

  /**
   * S1–S3, by the host or (`host` undefined) by the race's schedule.
   * True when a scheduled start was held back by the host's absence.
   */
  private async startRun(pin: string, host: LicenceHost | undefined): Promise<boolean> {
    const hostUserId = host?.userId;
    return this.mutate(pin, hostUserId, async (ref) => {
      if (hostUserId === undefined && ref.run.phase !== 'forming') return false;
      if (hostUserId === undefined && ref.meta.state === GameState.HostDisconnected) return true;
      if (ref.run.phase !== 'forming' || ref.meta.state !== GameState.Lobby) {
        throw new BadRequestException('escape.wrong_phase');
      }
      const v = await this.viewOf(ref);
      const tpl = ref.snap.template;
      // S1: empty teams go, then the connected unassigned join the smallest; in a
      // race (M7 §1.7) each of them plays solo, as a team of one.
      const race = v.session?.type === 'race';
      let teams = this.teamsOf(v).filter((t) => t.members.length);
      let ids = [...ref.run.teamIds];
      for (const p of v.players) {
        if (!p.connected || teamOf(teams, p.playerId)) continue;
        if (race) {
          const id = nextTeamId(ids);
          ids = [...ids, id];
          teams = [...teams, newTeam(tpl, id, soloName(p.nickname), [p.playerId])];
          continue;
        }
        const to = smallestTeam(teams, ref.run.maxSize);
        if (!to) break;
        teams = teams.map((t) => (t === to ? { ...t, members: [...t.members, p.playerId] } : t));
      }
      if (!teams.length) {
        // A scheduled start with nobody in is not tried again on a host sync.
        const plan = v.session?.race;
        if (hostUserId === undefined && v.session && plan) {
          await this.store.writeSession(pin, {
            ...v.session,
            race: { ...plan, noPlayers: true },
          });
        }
        throw new BadRequestException('escape.no_players');
      }
      // Owner question 4: a hosted event uses its licence at the room's first start.
      const stored = await this.useLicence(ref, v, host, teams);
      const live = this.pruneAndGetHolders(ref.id, v);
      // The same deal as the lobby preview, so every phone keeps its lobby role card.
      const codes = new Map(v.teams.map((r) => [r.team.id, r.code]));
      const recs = teams.map((t) =>
        fresh({ ...t, roles: dealRoles(tpl, t, live, 'forming') }, codes.get(t.id)),
      );
      const now = Date.now();
      const run: EscapeRun = {
        ...ref.run,
        phase: 'running',
        teamIds: recs.map((r) => r.team.id),
        clock: { ...ref.run.clock, startedAt: now },
      };
      // S2.
      await this.store.save(ref.id, {
        replace: true,
        run,
        teams: recs,
        members: { set: membersIndex(recs.map((r) => r.team)) },
      });
      // Atomic: a host gone meanwhile comes back to the run (prevState).
      const was = await this.store.setGameState(ref.id, GameState.Escape);
      this.scheduler.disarm(pin);
      let session = stored;
      if (session?.race && !session.race.started) {
        session = { ...session, race: { ...session.race, started: true } };
        await this.store.writeSession(pin, session);
      }
      await this.keepAlive(pin, ref.id);
      // S3.
      if (this.wrote(was)) {
        this.server
          .to(pin)
          .emit('game:state', { state: GameState.Escape, questionIndex: -1, totalQuestions: 0 });
      }
      await this.broadcast({ ...ref, run }, { ...v, run, teams: recs, now, session });
      this.startTicker(pin, ref.id);
      return false;
    });
  }

  // ── Play (U1–U5) ──

  /** A player's answer to a lock of their team's stage. */
  async submit(socket: EscapeSocket, dto: EscapeSubmit): Promise<EscapeSubmitAck> {
    const me = playerOf(socket, dto.pin);
    if (!me) return { ok: false, reason: 'not-joined' };
    return this.mutate(dto.pin, undefined, async (ref): Promise<EscapeSubmitAck> => {
      const at = await this.playing(ref, me.playerId);
      if (typeof at === 'string') return { ok: false, reason: at };
      const { rec, elapsed } = at;
      // U2: a blocked team waits; its answer is not checked, right or wrong.
      const retryAfterMs = await this.attempts.blocked(ref.id, rec.team.id);
      if (retryAfterMs > 0) return { ok: false, reason: 'rate-limited', retryAfterMs };
      const tpl = ref.snap.template;
      const { team, result } = submit(
        tpl,
        rec.team,
        { playerId: me.playerId, lockId: dto.lockId, roleId: dto.roleId, input: dto.input },
        elapsed,
      );
      if (result.outcome === 'refused') return { ok: false, reason: result.reason };
      const next: TeamRecord =
        result.outcome === 'wrong'
          ? { ...rec, team }
          : { ...rec, team, lastProgressAt: elapsed, stuck: false };
      await this.store.save(ref.id, { teams: [next] });
      if (result.outcome === 'wrong') await this.attempts.count(ref.id, rec.team.id);
      const update = submitUpdateOf(tpl, team.id, result, me.playerId, dto.roleId);
      const announce =
        result.outcome === 'stage-cleared' || result.outcome === 'escaped' ? [result.outcome] : [];
      const v = await this.viewOf(ref);
      await this.teamChanged(ref, v, team.id, update ? [update] : [], announce);
      // T4: the last team out ends the run.
      if (result.outcome === 'escaped' && allDone(ref.run.clock, v.teams, elapsed)) {
        await this.finale(ref);
      }
      return { ok: true, outcome: result.outcome };
    });
  }

  // ── Hints (H1–H4) ──

  /** H1: a team asks for the hint its phone was offered; a double tap releases one. */
  async askHint(socket: EscapeSocket, dto: EscapeAskHint): Promise<EscapeAskHintAck> {
    const me = playerOf(socket, dto.pin);
    if (!me) return { ok: false, reason: 'not-joined' };
    return this.mutate(dto.pin, undefined, async (ref): Promise<EscapeAskHintAck> => {
      const at = await this.playing(ref, me.playerId);
      if (typeof at === 'string') return { ok: false, reason: at };
      const team = useHint(ref.snap.template, at.rec.team, dto.hintId);
      if (team === at.rec.team) return { ok: false, reason: 'no-hint' };
      await this.store.save(ref.id, { teams: [{ ...at.rec, team }] });
      const update = hintUpdateOf(team.id, dto.hintId, 'request');
      await this.teamChanged(ref, await this.viewOf(ref), team.id, [update], ['hint']);
      return { ok: true };
    });
  }

  /**
   * H2: the host releases the next hint, paid, to one team or to every team
   * still playing (paused or not). The count of teams that got one. `hintId`
   * (one team): the hint the host confirmed; another next hint (released
   * meanwhile, or a new stage) is refused with `escape.hint-changed`, so the
   * host never pays for a hint it did not read. A confirmed hint for a team
   * whose time is up is refused with `escape.time-up`.
   */
  async hostHint(
    pin: string,
    hostUserId: string,
    teamId?: string,
    hintId?: string,
  ): Promise<number> {
    return this.mutate(pin, hostUserId, async (ref) => {
      await this.requireTool(ref, teamId === undefined ? 'hint-all' : 'hint-team');
      if (ref.run.phase !== 'running') throw new BadRequestException('escape.wrong_phase');
      if (teamId !== undefined && !ref.run.teamIds.includes(teamId)) {
        throw new NotFoundException('escape.team_not_found');
      }
      const tpl = ref.snap.template;
      const elapsed = runElapsed(ref.run.clock, Date.now());
      const stored = await this.store.teams(ref.id);
      const released: { rec: TeamRecord; hintId: string }[] = [];
      for (const id of teamId === undefined ? ref.run.teamIds : [teamId]) {
        const rec = stored.get(id);
        // One team asked for by id: a missing record is not found, not time up.
        if (!rec && teamId !== undefined) throw new NotFoundException('escape.team_not_found');
        const timedOut = !rec || rec.timedOut || isTimedOut(ref.run.clock, rec.team, elapsed);
        // The confirmed hint for one team: say why it was not given, never `released: 0`.
        if (hintId !== undefined && timedOut) throw new BadRequestException('escape.time-up');
        if (timedOut) continue;
        const hint = nextHint(tpl, rec.team);
        if (hintId !== undefined && (hint?.id !== hintId || rec.team.escapedAt !== null)) {
          throw new BadRequestException('escape.hint-changed');
        }
        const team = hint ? useHint(tpl, rec.team, hint.id) : rec.team;
        if (hintId !== undefined && team === rec.team) {
          throw new BadRequestException('escape.hint-changed');
        }
        if (hint && team !== rec.team) released.push({ rec: { ...rec, team }, hintId: hint.id });
      }
      if (!released.length) return 0;
      await this.store.save(ref.id, { teams: released.map((r) => r.rec) });
      const v = await this.viewOf(ref);
      for (const { rec, hintId } of released) {
        const update = hintUpdateOf(rec.team.id, hintId, 'host');
        await this.teamChanged(ref, v, rec.team.id, [update], ['hint']);
      }
      return released.length;
    });
  }

  // ── Pause and time (P1, P2, T1–T3) ──

  /**
   * P1: pauses or resumes every team's clock. Pausing a paused run (or resuming
   * a running one) changes nothing and sends nothing.
   */
  async pause(pin: string, hostUserId: string, paused: boolean): Promise<void> {
    await this.mutate(pin, hostUserId, async (ref) => {
      if (ref.run.phase !== 'running') throw new BadRequestException('escape.wrong_phase');
      const now = Date.now();
      const clock = paused ? pauseClock(ref.run.clock, now) : resumeClock(ref.run.clock, now);
      if (clock === ref.run.clock) return;
      const run: EscapeRun = { ...ref.run, clock };
      await this.store.saveRun(ref.id, run);
      if (!paused) await this.keepAlive(pin, ref.id);
      const next = { ...ref, run };
      await this.broadcast(next, { ...(await this.viewOf(next)), now });
    });
  }

  /**
   * T1: moves the deadline of one team, or of every team that has not escaped
   * (owner decision 2: never its score). Paused or not. Added time clears a
   * time-up at once when the new deadline is ahead; taking time away leaves
   * the time-up to the next tick, which announces it.
   */
  async adjustTime(pin: string, hostUserId: string, dto: EscapeAdjustTime): Promise<void> {
    await this.mutate(pin, hostUserId, async (ref) => {
      await this.requireTool(ref, dto.teamId === undefined ? 'adjust-all' : 'adjust-team');
      if (ref.run.phase !== 'running') throw new BadRequestException('escape.wrong_phase');
      const stored = await this.store.teams(ref.id);
      if (dto.teamId !== undefined) {
        const rec = ref.run.teamIds.includes(dto.teamId) ? stored.get(dto.teamId) : undefined;
        if (!rec) throw new NotFoundException('escape.team_not_found');
        if (rec.team.escapedAt !== null) throw new BadRequestException('escape.team_escaped');
      }
      const deltaMs = dto.deltaS * 1000;
      const elapsed = runElapsed(ref.run.clock, Date.now());
      const changed: TeamRecord[] = [];
      for (const id of dto.teamId === undefined ? ref.run.teamIds : [dto.teamId]) {
        const rec = stored.get(id);
        if (!rec || rec.team.escapedAt !== null) continue;
        const team = adjustTime(rec.team, deltaMs);
        const timedOut = rec.timedOut && isTimedOut(ref.run.clock, team, elapsed);
        changed.push({ ...rec, team, timedOut });
      }
      if (!changed.length) return;
      await this.store.save(ref.id, { teams: changed });
      const v = await this.viewOf(ref);
      for (const rec of changed) {
        const update: EscapeTeamUpdate = { teamId: rec.team.id, kind: 'time', deltaMs };
        await this.teamChanged(ref, v, rec.team.id, [update]);
      }
    });
  }

  // ── Host unlock (K1) ──

  /**
   * K1: the host opens a lock of the team's current stage, paused or not.
   * Nobody is credited; `hostUnlocks` keeps it for the results. It counts as
   * progress, and may clear the stage or escape the team. A timed-out team
   * gets time first (escape.time-up).
   */
  async unlock(pin: string, hostUserId: string, dto: EscapeUnlock): Promise<void> {
    await this.mutate(pin, hostUserId, async (ref) => {
      await this.requireTool(ref, 'unlock');
      if (ref.run.phase !== 'running') throw new BadRequestException('escape.wrong_phase');
      const rec = ref.run.teamIds.includes(dto.teamId)
        ? await this.store.team(ref.id, dto.teamId)
        : null;
      if (!rec) throw new NotFoundException('escape.team_not_found');
      const elapsed = runElapsed(ref.run.clock, Date.now());
      if (rec.timedOut || isTimedOut(ref.run.clock, rec.team, elapsed)) {
        throw new BadRequestException('escape.time-up');
      }
      const tpl = ref.snap.template;
      const { team, result } = hostUnlock(tpl, rec.team, dto.lockId, elapsed);
      if (result.outcome === 'refused') throw new BadRequestException(`escape.${result.reason}`);
      await this.store.save(ref.id, {
        teams: [{ ...rec, team, lastProgressAt: elapsed, stuck: false }],
      });
      const update = submitUpdateOf(tpl, team.id, result, null);
      const announce =
        result.outcome === 'stage-cleared' || result.outcome === 'escaped' ? [result.outcome] : [];
      const v = await this.viewOf(ref);
      await this.teamChanged(ref, v, team.id, update ? [update] : [], announce);
      if (result.outcome === 'escaped' && allDone(ref.run.clock, v.teams, elapsed)) {
        await this.finale(ref);
      }
    });
  }

  // ── Ticker (H3, T3, T4, K2) ──

  private startTicker(pin: string, id: GameId): void {
    this.touched.set(id, Date.now());
    this.ticker.start(id, this.timings.tickMs, () => this.tick(pin, id));
  }

  /**
   * One tick of a run, in its queue: timed hints (free), time-ups and stuck
   * flags per team, then the end of the run once every team is done. A run
   * that is no longer the room's running escape game stops its ticker.
   */
  private async tick(pin: string, id: GameId): Promise<void> {
    await this.queue.run(id, async () => {
      const meta = await this.game.getMeta(pin);
      // E4: the room moved to another game (back to its lobby, next quiz).
      const mine = meta?.id === id && meta.kind === 'escape';
      const [snap, run] = mine
        ? await Promise.all([this.store.snapshot(id), this.store.run(id)])
        : [null, null];
      if (!meta || !snap || !run || run.phase !== 'running') {
        this.forget(id);
        return;
      }
      // E3 sent the finale before the room ended (`closing`); nothing is left to tick.
      if (meta.state === GameState.Ended) {
        this.forget(id);
        return;
      }
      const ref: RunRef = { pin, id, meta, snap, run };
      if (Date.now() - (this.touched.get(id) ?? 0) >= this.timings.touchEveryMs) {
        this.touched.set(id, Date.now());
        await this.keepAlive(pin, id);
      }
      // R2: roles move off members gone past the grace, paused or not.
      if (snap.template.mode === 'roles' && this.gone.has(id)) {
        await this.reconcileRoles(ref, await this.viewOf(ref));
      }
      if (run.clock.pausedAt) return;
      const elapsed = runElapsed(run.clock, Date.now());
      const stored = await this.store.teams(id);
      const recs = run.teamIds.flatMap((t) => stored.get(t) ?? []);
      const ticks = recs.map((rec) =>
        tickTeam(snap.template, rec, run.clock, elapsed, this.timings.stuckMs),
      );
      const changed = ticks.filter((t, i) => t.rec !== recs[i]).map((t) => t.rec);
      if (changed.length) await this.store.save(id, { teams: changed });
      const done = allDone(
        run.clock,
        ticks.map((t) => t.rec),
        elapsed,
      );
      if (!ticks.some((t) => t.events.length) && !done) return;
      const v = await this.viewOf(ref);
      for (const { rec, events } of ticks) {
        if (!events.length) continue;
        const teamId = rec.team.id;
        const updates: EscapeTeamUpdate[] = [];
        const announce: EscapeAnnounce['kind'][] = [];
        for (const e of events) {
          if (e === 'time-up') {
            updates.push(timeUpOf(teamId));
            announce.push('time-up');
          } else if (e.startsWith('hint:')) {
            updates.push(hintUpdateOf(teamId, e.slice('hint:'.length), 'timer'));
            announce.push('hint');
          }
        }
        // Stuck and unstuck alone: the host's team detail only.
        await this.teamChanged(ref, v, teamId, updates, [...new Set(announce)]);
      }
      if (done) await this.finale(ref);
    });
  }

  // ── End and finale (E1–E3, T4) ──

  /** E1: the host ends the run now (running only); the finale follows at once. */
  async end(pin: string, hostUserId: string): Promise<void> {
    await this.mutate(pin, hostUserId, async (ref) => {
      if (ref.run.phase !== 'running') throw new BadRequestException('escape.wrong_phase');
      await this.finale(ref);
    });
  }

  /**
   * E2: the finale to the whole room: from a running run (it ends first), or
   * again from the finale, with the same results.
   */
  async showFinale(pin: string, hostUserId: string): Promise<void> {
    await this.mutate(pin, hostUserId, async (ref) => {
      if (ref.run.phase === 'forming') throw new BadRequestException('escape.wrong_phase');
      const stored = ref.run.phase === 'finale' ? await this.store.results(ref.id) : null;
      if (stored) await this.sendFinale(ref, stored, await this.viewOf(ref));
      else await this.finale(ref);
    });
  }

  /**
   * E3: the room is about to end under the run (GameEngine.beforeEnd, awaited by
   * host:end and the host window before game:ended). A running run gets its
   * finale, in its queue; any other has nothing to send.
   */
  private async closing(pin: string, id: GameId): Promise<void> {
    this.scheduler.disarm(pin);
    await this.queue.run(id, async () => {
      const ref = await this.requireRun(pin).catch(() => null);
      if (ref?.id !== id || ref.run.phase !== 'running') return;
      await this.finale(ref, true);
    });
  }

  /**
   * A finished run's stored finale, the room ended or not, for someone who was
   * in this run (§1.6 of the M4 plan):
   * - a phone, by the session token it joined with: the token's room is the
   *   run's and its player was in a team of the run. A socket that is a player
   *   must take this path; its PIN alone never passes;
   * - the run's host (no player, not a screen), by its signed-in user, live room or not (M5);
   * - a host console (no player, not a screen), by its live room, while the PIN's
   *   current game is still this run. A recycled PIN or a room that moved on to
   *   another game has another id.
   * A screen never reads it (M6 §1.4): it gets the screen finale from escape:sync.
   */
  async results(socket: EscapeSocket, dto: EscapeResults): Promise<EscapeFinale> {
    const id = dto.gameId as GameId;
    const [pin, stored] = await Promise.all([this.store.roomOf(id), this.store.resultsOf(id)]);
    if (!pin || !stored) throw new NotFoundException('escape.not_found');
    const who = await this.wasInRun(socket, dto.sessionToken, id, pin);
    if (!who) throw new ForbiddenException('escape.not_in_room');
    // M7 §1.7: a race's phone gets the top teams and its own row, as at the finale.
    if (who === 'host' || !stored.race) return stored.finale;
    return finaleFor(stored.finale, who.teamId, limitsOf('race'));
  }

  /** How the socket was in the run: a phone of a team, the host, or not at all (null). */
  private async wasInRun(
    socket: EscapeSocket,
    sessionToken: string | undefined,
    id: GameId,
    pin: string,
  ): Promise<{ teamId: string } | 'host' | null> {
    const session = sessionToken ? await this.game.resolveSession(sessionToken) : null;
    if (session) {
      const teamId =
        session.pin === pin ? await this.store.teamOfPlayer(id, session.playerId) : null;
      return teamId === null ? null : { teamId };
    }
    if (socket.data.playerId) return null;
    // Never a screen (spectator:join sets `projection`), even one signed in as the
    // host: a screen gets the screen finale from escape:sync instead (M6 §1.4).
    if (socket.data.projection !== undefined) return null;
    // The run's host, signed in, live room or not (M5 §1.5: a console back after the room closed).
    const user = socket.data.user?.id;
    if (user && user === (await this.store.hostOf(id))) return 'host';
    if (socket.data.pin !== pin) return null;
    return (await this.game.getMeta(pin))?.id === id ? 'host' : null;
  }

  /**
   * E2/T4: the run is over. Clocks freeze, teams past their deadline count as
   * timed out, the ranking and awards are kept in `results`, the room goes to
   * its podium, and everyone in it gets the finale (no answers: names, counts
   * and times; screens without host columns, `sendFinale`). The host console
   * also gets its full view.
   *
   * `closed` (E3): the room is ending under the run (`closing`): the results
   * and the finale go out, the state is left to GameEngine, which ends the room.
   * Without its host (HOST_DISCONNECTED, owner decision 1) the podium is where
   * the room resumes when the host is back.
   */
  private async finale(ref: RunRef, closed = false): Promise<EscapeFinale> {
    const now = Date.now();
    const clock = endClock(ref.run.clock, now);
    const run: EscapeRun = { ...ref.run, phase: 'finale', clock };
    const next = { ...ref, run };
    const elapsed = runElapsed(clock, now);
    const v = await this.viewOf(next);
    const late: TeamRecord[] = [];
    const teams = v.teams.map((r) => {
      if (r.timedOut || !isTimedOut(clock, r.team, elapsed)) return r;
      const out = { ...r, timedOut: true };
      late.push(out);
      return out;
    });
    const final = { ...v, run, teams };
    const finale = finaleOf(final, ref.id);
    await this.store.save(ref.id, { run, teams: late });
    await this.store.saveResults(ref.id, finale, viewLimits(final) !== null);
    this.forget(ref.id);
    if (!closed) {
      // Atomic: an ended room stays ended; without its host, PODIUM waits in prevState.
      const was = await this.store.setGameState(ref.id, GameState.Podium);
      if (was !== GameState.Ended) await this.keepAlive(ref.pin, ref.id);
      if (this.wrote(was)) {
        this.server
          .to(ref.pin)
          .emit('game:state', { state: GameState.Podium, questionIndex: -1, totalQuestions: 0 });
      }
    }
    await this.broadcast(next, final);
    // Teams the finale found past their deadline: their time-up first.
    for (const rec of late) {
      this.server
        .to([escapeRooms.team(ref.id, rec.team.id), escapeRooms.host(ref.pin)])
        .emit('escape:team-update', timeUpOf(rec.team.id));
    }
    await this.sendFinale(ref, finale, final);
    return finale;
  }

  /**
   * M6 §1.4: the full finale to the room's phones and its host console; every
   * other socket of the PIN room (a paired screen, an unpaired copy, a
   * participant's follow copy) gets the screen finale, without host columns.
   * A host console that also joined as a spectator counts as a screen.
   */
  private async sendFinale(ref: RunRef, finale: EscapeFinale, v: RunView): Promise<void> {
    const screen = screenFinaleOf(finale, v);
    const limits = viewLimits(v);
    for (const s of await this.server.in(ref.pin).fetchSockets()) {
      const d = s.data;
      const phone = d.pin === ref.pin && !!d.playerId;
      if (isHostConsole(d, ref.pin, ref.meta.hostUserId)) s.emit('escape:finale', finale);
      else if (phone) {
        // M7 §1.7: a race's phone gets the top teams and its own row.
        const team = teamOf(this.teamsOf(v), d.playerId!)?.id ?? null;
        s.emit('escape:finale', finaleFor(finale, team, limits));
      } else s.emit('escape:screen-finale', screen);
    }
  }

  /** The room's keys and the run's get their TTL again. */
  private async keepAlive(pin: string, id: GameId): Promise<void> {
    await Promise.all([this.game.touchRoom(pin), this.store.touch(id), this.store.touchRoom(pin)]);
  }

  /** Whether setGameState wrote the state itself, from the state it found. */
  private wrote(was: GameState | null): boolean {
    return was !== null && was !== GameState.Ended && was !== GameState.HostDisconnected;
  }

  /** Drops what this process keeps for a run that no longer plays (ticker, presence). */
  private forget(id: GameId): void {
    this.ticker.stop(id);
    this.gone.delete(id);
    this.touched.delete(id);
  }

  /**
   * U1: the player's team record and the run time, when the player may play
   * now; otherwise why not. The deadline decides time-up, before a tick has
   * flagged it.
   */
  private async playing(
    ref: RunRef,
    playerId: string,
  ): Promise<{ rec: TeamRecord; elapsed: number } | EscapeRefusal> {
    if (ref.run.phase !== 'running') return 'not-running';
    if (ref.run.clock.pausedAt) return 'paused';
    const teamId = await this.store.teamOfPlayer(ref.id, playerId);
    const rec = teamId ? await this.store.team(ref.id, teamId) : null;
    if (!rec) return 'no-team';
    const elapsed = runElapsed(ref.run.clock, Date.now());
    if (rec.timedOut || isTimedOut(ref.run.clock, rec.team, elapsed)) return 'time-up';
    return { rec, elapsed };
  }

  // ── Guards ──

  /**
   * The room's current game as an escape run: `session.not_found` without a
   * room, `host.forbidden` for another host (requireHost's semantics), and
   * `escape.not_found` when the game is not an escape game.
   */
  async requireRun(pin: string, hostUserId?: string): Promise<RunRef> {
    const meta =
      hostUserId === undefined
        ? await this.game.getMeta(pin)
        : await this.requireHostMeta(pin, hostUserId);
    if (!meta) throw new NotFoundException('session.not_found');
    if (meta.kind !== 'escape') throw new NotFoundException('escape.not_found');
    const [snap, run] = await Promise.all([this.store.snapshot(meta.id), this.store.run(meta.id)]);
    if (!snap || !run) throw new NotFoundException('escape.not_found');
    return { pin, id: meta.id, meta, snap, run };
  }

  /**
   * M7 §1.1: the room's session type allows this host tool, or
   * `escape.not_in_session`. A room without a session (opened before session
   * types) is hosted: every tool.
   */
  private async requireTool(ref: RunRef, tool: EscapeTool): Promise<void> {
    const session = await this.store.session(ref.pin);
    if (session && !toolAllowed(session.type, tool)) {
      throw new BadRequestException('escape.not_in_session');
    }
  }

  private async requireHostMeta(pin: string, hostUserId: string): Promise<GameMeta> {
    const meta = await this.game.getMeta(pin);
    if (!meta) throw new NotFoundException('session.not_found');
    if (meta.hostUserId !== hostUserId) throw new ForbiddenException('host.forbidden');
    return meta;
  }

  /** Runs `job` on the current run, one at a time per game, with the run read inside the queue. */
  private async mutate<T>(
    pin: string,
    hostUserId: string | undefined,
    job: (ref: RunRef) => Promise<T>,
  ): Promise<T> {
    const first = await this.requireRun(pin, hostUserId);
    return this.queue.run(first.id, async () => {
      const ref = await this.requireRun(pin, hostUserId);
      // The room moved to another game while this waited.
      if (ref.id !== first.id) throw new NotFoundException('escape.not_found');
      return job(ref);
    });
  }

  // ── Helpers ──

  /** O3/O4: the host's template, checked and frozen with its version. */
  private async freeze(
    hostUserId: string,
    templateId: string,
    type: EscapeSession['type'],
  ): Promise<EscapeSnapshot> {
    const row = await this.templates.get(hostUserId, templateId);
    const template = { id: row.id, ...row.content };
    const problems = validateTemplate(template);
    if (problems.length) {
      throw new BadRequestException({ code: 'escape_template.invalid', problems });
    }
    if (!modeAllowed(type, template.mode)) throw new BadRequestException('escape.session_mode');
    return { templateId: row.id, version: row.version, template, takenAt: Date.now() };
  }

  /** Marks game `id` as this escape run and writes its first records. */
  private async openOn(
    pin: string,
    id: GameId,
    hostUserId: string,
    snap: EscapeSnapshot,
    durationMin?: number,
    session?: EscapeSession,
  ): Promise<void> {
    // A race's teams hold one player (solo) or up to RACE_TEAM_MAX (team codes).
    const race = (session ?? (await this.store.session(pin)))?.race;
    const maxSize = !race ? 0 : race.format === 'solo' ? 1 : RACE_TEAM_MAX;
    const run: EscapeRun = {
      phase: 'forming',
      formation: 'auto',
      maxSize,
      teamIds: [],
      clock: {
        startedAt: 0,
        pausedAt: 0,
        pausedMs: 0,
        endedElapsedMs: null,
        limitMs: (durationMin ?? snap.template.targetMinutes) * 60_000,
      },
    };
    await this.redis.hset(
      gameKeys.game(id),
      gameHash({ kind: 'escape', title: snap.template.title }),
    );
    await this.store.writeOpen(id, pin, hostUserId, snap, run, session);
  }

  /** A room's session from its create (M7 §1.4): a hosted one freezes its licence. */
  private async newSession(
    host: LicenceHost,
    type: EscapeSession['type'],
    dto: Pick<EscapeCreate, 'licenceId' | 'race'>,
  ): Promise<EscapeSession> {
    const base = { licenceUsed: false, race: null, licence: null, phoneHostUserId: null };
    if (type === 'group') {
      return { ...base, type, cap: capOf(type), phoneHostUserId: host.userId };
    }
    if (type === 'race') {
      // escapeCreateSchema gives every race its race data.
      if (!dto.race) throw new BadRequestException('validation');
      const { format } = dto.race;
      const startsAt = dto.race.startsAt ?? null;
      const lead = startsAt === null ? null : startsAt - Date.now();
      // 5 s of slack on both bounds: the dialog's "in 1 minute" reaches us a little late.
      const min = this.timings.raceMinLeadMs - RACE_LEAD_SLACK_MS;
      const max = RACE_MAX_LEAD_MIN * 60_000 + RACE_LEAD_SLACK_MS;
      if (lead !== null && (lead < min || lead > max)) {
        throw new BadRequestException('escape.race_start_out_of_range');
      }
      return { ...base, type, cap: capOf(type), race: { format, startsAt, started: false } };
    }
    const licence = await this.licenceFor(host, dto.licenceId);
    return { ...base, type, cap: capOf(type, licence), licence: frozen(licence) };
  }

  /** The licence a hosted event runs under: the one chosen, or the host's only usable one. */
  private async licenceFor(host: LicenceHost, licenceId?: string): Promise<Licence> {
    const now = Date.now();
    if (licenceId === undefined) {
      const usable = await this.licences.usableBy(host, now);
      if (usable.length !== 1) throw new ForbiddenException(LICENCE_REQUIRED);
      return usable[0];
    }
    const checked = await this.licences.check(host, licenceId, now);
    if (!checked.ok) throw new ForbiddenException(licenceErrorCode(checked.reason));
    return checked.licence;
  }

  /** Everything a payload is built from, read once. R1: connected = a live socket in the room. */
  private async viewOf(ref: RunRef): Promise<RunView> {
    const [recs, records, sockets, session] = await Promise.all([
      this.store.teams(ref.id),
      this.game.players(ref.pin),
      this.server.in(ref.pin).fetchSockets(),
      this.store.session(ref.pin),
    ]);
    const live = new Set(
      sockets.filter((s) => s.data.pin === ref.pin && s.data.playerId).map((s) => s.data.playerId),
    );
    return {
      id: ref.id,
      snap: ref.snap,
      run: ref.run,
      teams: ref.run.teamIds.flatMap((t) => recs.get(t) ?? []),
      players: [...records]
        .sort(([, a], [, b]) => a.joinedAt - b.joinedAt)
        .map(([playerId, r]) => ({
          playerId,
          nickname: r.nickname,
          avatar: r.avatar,
          connected: live.has(playerId),
          userId: r.userId,
        })),
      session,
      now: Date.now(),
    };
  }

  private teamsOf(v: RunView): TeamState[] {
    return v.teams.map((r) => r.team);
  }

  /**
   * R1: who may hold a role: the members with a live socket, plus those gone
   * for less than `roleGraceMs` (since boot for a member never seen gone, R4).
   * Expired entries are dropped.
   */
  private pruneAndGetHolders(id: GameId, v: RunView): Set<string> {
    const gone = this.gone.get(id);
    const out = new Set<string>();
    for (const p of v.players) {
      const since = gone?.get(p.playerId) ?? this.bootAt;
      const within = v.now - since < this.timings.roleGraceMs;
      if (p.connected || within) out.add(p.playerId);
      if (!within) gone?.delete(p.playerId);
      // Just booted: a member without a socket is tracked until the grace ends.
      else if (gone && !p.connected) gone.set(p.playerId, since);
    }
    if (gone && !gone.size) this.gone.delete(id);
    return out;
  }

  /**
   * F4/R2/R3: recomputes the roles of `teamIds` (all by default) for the
   * current holders. A team whose roles changed is saved, and its phones get
   * `team-update {roles}` and their new state. Whether any changed.
   */
  private async reconcileRoles(ref: RunRef, v: RunView, teamIds?: string[]): Promise<boolean> {
    const tpl = ref.snap.template;
    if (tpl.mode !== 'roles' || (ref.run.phase !== 'running' && ref.run.phase !== 'forming')) {
      return false;
    }
    const live = this.pruneAndGetHolders(ref.id, v);
    const changed: TeamRecord[] = [];
    const recs = v.teams.map((rec) => {
      if (teamIds && !teamIds.includes(rec.team.id)) return rec;
      const roles = dealRoles(tpl, rec.team, live, ref.run.phase);
      if (sameRoles(roles, rec.team.roles)) return rec;
      const next = { ...rec, team: { ...rec.team, roles } };
      changed.push(next);
      return next;
    });
    if (!changed.length) return false;
    await this.store.save(ref.id, { teams: changed });
    const next = { ...v, teams: recs };
    for (const rec of changed) {
      await this.teamChanged(ref, next, rec.team.id, [{ teamId: rec.team.id, kind: 'roles' }]);
    }
    return true;
  }

  /** Moves a player, recomputes both teams' roles (F4) and saves; the new view. */
  private async applyMove(
    ref: RunRef,
    v: RunView,
    playerId: string,
    teamId: string | null,
  ): Promise<RunView> {
    const before = this.teamsOf(v);
    const after = moveMember(before, playerId, teamId);
    if (after === before) return v;
    const live = this.pruneAndGetHolders(ref.id, v);
    const tpl = ref.snap.template;
    const changed: TeamRecord[] = [];
    const recs = v.teams.map((rec, i) => {
      if (after[i] === before[i]) return rec;
      const roles = dealRoles(tpl, after[i], live, ref.run.phase);
      const next = { ...rec, team: { ...after[i], roles } };
      changed.push(next);
      return next;
    });
    await this.store.save(ref.id, {
      teams: changed,
      members: teamId === null ? { del: [playerId] } : { set: { [playerId]: teamId } },
    });
    return { ...v, teams: recs, now: Date.now() };
  }

  // ── Emit (§2 routing) ──

  /**
   * Whether the run is still the room's current game: after back-to-lobby or a
   * next quiz, a command still in flight on the old run sends nothing.
   */
  private async isCurrent(ref: RunRef): Promise<boolean> {
    return (await this.game.getMeta(ref.pin))?.id === ref.id;
  }

  /**
   * Every phone its state (and its team room), or only those of `phones`; the
   * host its view, the screens the board.
   */
  private async broadcast(ref: RunRef, v: RunView, phones?: ReadonlySet<string>): Promise<void> {
    if (!(await this.isCurrent(ref))) return;
    for (const s of await this.server.in(ref.pin).fetchSockets()) {
      const { playerId } = s.data;
      if (s.data.pin !== ref.pin || !playerId) continue;
      if (phones && !phones.has(playerId)) continue;
      this.placeInTeamRoom(s, ref.id, v, playerId);
      s.emit('escape:state', playerStateOf(v, playerId));
    }
    this.toHostAndBoard(ref, v);
  }

  /**
   * M7 §1.7: whom a race formation change concerns: the mover and the members
   * of its team before and after. A race phone lists its own team only, so no
   * other phone's state changed.
   */
  private formationPhones(before: RunView, after: RunView, playerId: string): Set<string> {
    const out = new Set([playerId]);
    for (const view of [before, after]) {
      for (const id of teamOf(this.teamsOf(view), playerId)?.members ?? []) out.add(id);
    }
    return out;
  }

  /**
   * U5: one team changed. With updates, its phones get their new state, the
   * team room and the host the updates, and the board is scheduled; the host
   * always gets the team's detail. `announce` banners the screens and the host.
   */
  private async teamChanged(
    ref: RunRef,
    v: RunView,
    teamId: string,
    updates: EscapeTeamUpdate[],
    announce: EscapeAnnounce['kind'][] = [],
  ): Promise<void> {
    const rec = v.teams.find((r) => r.team.id === teamId);
    if (!rec || !(await this.isCurrent(ref))) return;
    const host = escapeRooms.host(ref.pin);
    if (updates.length) {
      for (const s of await this.server.in(ref.pin).fetchSockets()) {
        const { playerId } = s.data;
        if (s.data.pin !== ref.pin || !playerId || !rec.team.members.includes(playerId)) continue;
        this.placeInTeamRoom(s, ref.id, v, playerId);
        s.emit('escape:state', playerStateOf(v, playerId));
      }
      const to = this.server.to([escapeRooms.team(ref.id, teamId), host]);
      for (const u of updates) to.emit('escape:team-update', u);
    }
    this.server.to(host).emit('escape:host-team', hostTeamOf(v, rec));
    for (const kind of announce) {
      this.server
        .to([escapeRooms.board(ref.pin), host])
        .emit('escape:announce', announceOf(kind, rec.team));
    }
    if (updates.length) this.toBoard(ref, v);
  }

  /**
   * The host state to the host room: at once, except in a race (M7 §1.7),
   * where it is coalesced with the board, at most every `boardEveryMs` of the race.
   */
  private toHost(ref: RunRef, v: RunView): void {
    if (!viewLimits(v)) {
      this.server.to(escapeRooms.host(ref.pin)).emit('escape:host', hostStateOf(v));
      return;
    }
    this.throttled(ref.pin, v, { board: false, host: true });
  }

  /**
   * The host state and (with `board`) the board. In a race one throttled send
   * carries both, so the board does not wait behind the host's slot (M7 §1.7).
   */
  private toHostAndBoard(ref: RunRef, v: RunView, board = true): void {
    if (viewLimits(v)) {
      this.throttled(ref.pin, v, { board, host: true });
      return;
    }
    this.toHost(ref, v);
    if (board) this.toBoard(ref, v);
  }

  /** The player's socket in its team's room and no other team's. */
  private placeInTeamRoom(s: AnySocket, id: GameId, v: RunView, playerId: string): void {
    const team = teamOf(this.teamsOf(v), playerId);
    const want = team ? escapeRooms.team(id, team.id) : null;
    for (const room of s.rooms) {
      if (room.startsWith(TEAM_ROOM_PREFIX) && room !== want) void s.leave(room);
    }
    if (want) void s.join(want);
  }

  /** The board to the screens and the host, at most every `boardEveryMs` (the latest wins). */
  private toBoard(ref: RunRef, v: RunView): void {
    this.throttled(ref.pin, v, { board: true, host: false });
  }

  /** The throttle of the board (and, in a race, of the host state): now, or with the next. */
  private throttled(pin: string, v: RunView, what: { board: boolean; host: boolean }): void {
    const held = this.boards.get(pin);
    if (held) {
      held.pending ||= what.board;
      held.host ||= what.host;
      return;
    }
    this.emitHeld(pin, v, what);
    this.holdBoard(pin, this.boardEveryMs(v));
  }

  /** The board period: the timings', or a race's when longer. */
  private boardEveryMs(v: RunView): number {
    return Math.max(this.timings.boardEveryMs, viewLimits(v)?.boardEveryMs ?? 0);
  }

  /** Nothing for `everyMs`; then the latest, if one was asked for meanwhile. */
  private holdBoard(pin: string, everyMs: number): void {
    const held = {
      pending: false,
      host: false,
      timer: setTimeout(() => {
        if (this.boards.get(pin) === held) this.boards.delete(pin);
        if (!held.pending && !held.host) return;
        const what = { board: held.pending, host: held.host };
        void this.boardNow(pin, what).catch((err: Error) =>
          this.log.warn(`board ${pin}: ${err.message}`),
        );
      }, everyMs),
    };
    held.timer.unref?.();
    this.boards.set(pin, held);
  }

  /** What the throttle held back; nothing when the room or its run is gone meanwhile. */
  private async boardNow(pin: string, what: { board: boolean; host: boolean }): Promise<void> {
    const meta = await this.game.getMeta(pin);
    if (meta?.kind !== 'escape') return;
    const [snap, run] = await Promise.all([this.store.snapshot(meta.id), this.store.run(meta.id)]);
    if (!snap || !run) return;
    const v = await this.viewOf({ pin, id: meta.id, meta, snap, run });
    this.throttled(pin, v, what);
  }

  private emitHeld(pin: string, v: RunView, what: { board: boolean; host: boolean }): void {
    if (what.board) this.emitBoard(pin, v);
    if (what.host) this.server.to(escapeRooms.host(pin)).emit('escape:host', hostStateOf(v));
  }

  private emitBoard(pin: string, v: RunView): void {
    this.server
      .to([escapeRooms.board(pin), escapeRooms.host(pin)])
      .emit('escape:board', boardOf(v));
  }
}
