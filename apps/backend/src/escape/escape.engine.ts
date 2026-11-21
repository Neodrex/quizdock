import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  type ClientToServerEvents,
  type EscapeCreate,
  type EscapeMove,
  type EscapeOpen,
  type EscapeTeams,
  GameState,
  type ServerToClientEvents,
} from '@quiz-dock/contracts';
import type { Server, Socket } from 'socket.io';
import { playerOf, type GameSocketData } from '../game/game.gateway';
import { gameHash } from '../game/game-hash';
import { gameKeys, type GameId } from '../game/game.keys';
import { GameService } from '../game/game.service';
import type { GameMeta } from '../game/game.types';
import { RedisService } from '../redis/redis.service';
import type { EscapeRun, EscapeSnapshot, TeamRecord } from './escape-live.types';
import { boardOf, hostStateOf, outlineOf, playerStateOf, type RunView } from './escape-payloads';
import { newTeam } from './escape-rules';
import { validateTemplate } from './escape-template';
import { EscapeTemplatesService } from './escape-templates.service';
import { dealPlayers, makeTeams, moveMember, rolesFor, smallestTeam, teamOf } from './escape-teams';
import { EscapeTimings } from './escape-timings';
import { escapeRooms } from './escape.keys';
import { EscapeStore } from './escape.store';
import type { TeamState } from './escape.types';
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

const fresh = (team: TeamState): TeamRecord => ({
  team,
  lastProgressAt: 0,
  stuck: false,
  timedOut: false,
});

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
export class EscapeEngine {
  private readonly log = new Logger(EscapeEngine.name);
  private server!: EscapeServer;
  private readonly queue = new SerialQueue();
  /** Board throttle per room: when it last went out, and the send waiting, if any. */
  private readonly boards = new Map<string, { at: number; timer: NodeJS.Timeout | null }>();

  constructor(
    private readonly game: GameService,
    private readonly store: EscapeStore,
    private readonly templates: EscapeTemplatesService,
    private readonly timings: EscapeTimings,
    private readonly redis: RedisService,
  ) {}

  bindServer(server: EscapeServer): void {
    this.server = server;
  }

  // ── Open (O1–O4) ──

  /** O1: a new room whose first game is this run, forming. Returns the PIN. */
  async create(hostUserId: string, dto: EscapeCreate): Promise<string> {
    const snap = await this.freeze(hostUserId, dto.templateId);
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
    await this.openOn(meta.id, snap, dto.durationMin);
    return pin;
  }

  /** O2: a run as the room's next game, from its lobby; the room's players unassigned. */
  async open(pin: string, hostUserId: string, dto: EscapeOpen): Promise<void> {
    const first = await this.requireHostMeta(pin, hostUserId);
    await this.queue.run(first.id, async () => {
      const meta = await this.requireHostMeta(pin, hostUserId);
      if (meta.state !== GameState.Lobby) {
        throw new BadRequestException('session.next_quiz_from_lobby');
      }
      const snap = await this.freeze(hostUserId, dto.templateId);
      const id = await this.game.openGameWith(pin, null);
      await this.openOn(id, snap, dto.durationMin);
      this.server
        .to(pin)
        .emit('game:state', { state: GameState.Lobby, questionIndex: -1, totalQuestions: 0 });
      const ref = await this.requireRun(pin);
      await this.broadcast(ref, await this.viewOf(ref));
    });
  }

  // ── Sync (§2 routing) ──

  /** The socket joins its escape rooms and gets its view: host console, phone or screen. */
  async sync(socket: EscapeSocket, pin: string): Promise<void> {
    await this.mutate(pin, undefined, async (ref) => {
      const { data } = socket;
      if (data.isHostControl && data.pin === pin && data.user?.id === ref.meta.hostUserId) {
        await socket.join(escapeRooms.host(pin));
        const v = await this.viewOf(ref);
        socket.emit('escape:outline', outlineOf(ref.snap));
        socket.emit('escape:host', hostStateOf(v));
        socket.emit('escape:board', boardOf(v));
        return;
      }
      const me = playerOf(socket, pin);
      if (me) {
        const v = await this.viewOf(ref);
        // F5: a late joiner in auto formation goes to the smallest team.
        const late =
          ref.run.phase === 'running' &&
          ref.run.formation === 'auto' &&
          !teamOf(this.teamsOf(v), me.playerId);
        const to = late ? smallestTeam(this.teamsOf(v), ref.run.maxSize) : null;
        if (to) {
          await this.broadcast(ref, await this.applyMove(ref, v, me.playerId, to.id));
          return;
        }
        this.placeInTeamRoom(socket, ref.id, v, me.playerId);
        socket.emit('escape:state', playerStateOf(v, me.playerId));
        // The host sees who is here.
        this.toHost(ref, v);
        return;
      }
      if (!socket.rooms.has(pin)) throw new ForbiddenException('escape.not_in_room');
      await socket.join(escapeRooms.board(pin));
      socket.emit('escape:board', boardOf(await this.viewOf(ref)));
    });
  }

  /** A player's socket left: the host and the screens see it (roles move in 3.14). */
  async presenceChanged(pin: string): Promise<void> {
    const meta = await this.game.getMeta(pin);
    if (meta?.kind !== 'escape') return;
    const ref = await this.requireRun(pin);
    const v = await this.viewOf(ref);
    this.toHost(ref, v);
    this.toBoard(ref, v);
  }

  // ── Formation (F1–F5) ──

  /** F1/F2: new teams t1…tN, dealt (auto) or empty (self). Forming only. */
  async teams(pin: string, hostUserId: string, dto: EscapeTeams): Promise<void> {
    await this.mutate(pin, hostUserId, async (ref) => {
      if (ref.run.phase !== 'forming') throw new BadRequestException('escape.wrong_phase');
      const v = await this.viewOf(ref);
      const tpl = ref.snap.template;
      let teams = makeTeams(dto.count, dto.names).map((s) => newTeam(tpl, s.id, s.name, []));
      if (dto.mode === 'auto') {
        teams = dealPlayers(
          teams,
          v.players.filter((p) => p.connected).map((p) => p.playerId),
        );
      }
      const live = this.connectedOf(v);
      const recs = teams.map((t) => fresh({ ...t, roles: rolesFor(tpl, t, live) }));
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
      const { phase } = ref.run;
      if (phase !== 'forming' && phase !== 'running') {
        throw new BadRequestException('escape.wrong_phase');
      }
      if (dto.teamId === null && phase !== 'forming') {
        throw new BadRequestException('escape.wrong_phase');
      }
      const v = await this.viewOf(ref);
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

  // ── Start (S1–S3) ──

  async start(pin: string, hostUserId: string): Promise<void> {
    await this.mutate(pin, hostUserId, async (ref) => {
      if (ref.run.phase !== 'forming') throw new BadRequestException('escape.wrong_phase');
      const v = await this.viewOf(ref);
      const tpl = ref.snap.template;
      // S1: empty teams go, then the connected unassigned join the smallest.
      let teams = this.teamsOf(v).filter((t) => t.members.length);
      for (const p of v.players) {
        if (!p.connected || teamOf(teams, p.playerId)) continue;
        const to = smallestTeam(teams, ref.run.maxSize);
        if (!to) break;
        teams = teams.map((t) => (t === to ? { ...t, members: [...t.members, p.playerId] } : t));
      }
      if (!teams.length) throw new BadRequestException('escape.no_players');
      const live = this.connectedOf(v);
      const recs = teams.map((t) => fresh({ ...t, roles: rolesFor(tpl, t, live) }));
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
      await this.redis.hset(gameKeys.game(ref.id), gameHash({ state: GameState.Escape }));
      await this.game.touchRoom(pin);
      // S3.
      this.server
        .to(pin)
        .emit('game:state', { state: GameState.Escape, questionIndex: -1, totalQuestions: 0 });
      await this.broadcast({ ...ref, run }, { ...v, run, teams: recs, now });
    });
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
  private async freeze(hostUserId: string, templateId: string): Promise<EscapeSnapshot> {
    const row = await this.templates.get(hostUserId, templateId);
    const template = { id: row.id, ...row.content };
    const problems = validateTemplate(template);
    if (problems.length) {
      throw new BadRequestException({ code: 'escape_template.invalid', problems });
    }
    return { templateId: row.id, version: row.version, template, takenAt: Date.now() };
  }

  /** Marks game `id` as this escape run and writes its first records. */
  private async openOn(id: GameId, snap: EscapeSnapshot, durationMin?: number): Promise<void> {
    const run: EscapeRun = {
      phase: 'forming',
      formation: 'auto',
      maxSize: 0,
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
    await this.store.writeOpen(id, snap, run);
  }

  /** Everything a payload is built from, read once. R1: connected = a live socket in the room. */
  private async viewOf(ref: RunRef): Promise<RunView> {
    const [recs, records, sockets] = await Promise.all([
      this.store.teams(ref.id),
      this.game.players(ref.pin),
      this.server.in(ref.pin).fetchSockets(),
    ]);
    const live = new Set(
      sockets.filter((s) => s.data.pin === ref.pin && s.data.playerId).map((s) => s.data.playerId),
    );
    return {
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
        })),
      now: Date.now(),
    };
  }

  private teamsOf(v: RunView): TeamState[] {
    return v.teams.map((r) => r.team);
  }

  private connectedOf(v: RunView): Set<string> {
    return new Set(v.players.filter((p) => p.connected).map((p) => p.playerId));
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
    const live = this.connectedOf(v);
    const tpl = ref.snap.template;
    const changed: TeamRecord[] = [];
    const recs = v.teams.map((rec, i) => {
      if (after[i] === before[i]) return rec;
      const next = { ...rec, team: { ...after[i], roles: rolesFor(tpl, after[i], live) } };
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

  /** Every phone its state (and its team room), the host its view, the screens the board. */
  private async broadcast(ref: RunRef, v: RunView): Promise<void> {
    for (const s of await this.server.in(ref.pin).fetchSockets()) {
      const { playerId } = s.data;
      if (s.data.pin !== ref.pin || !playerId) continue;
      this.placeInTeamRoom(s, ref.id, v, playerId);
      s.emit('escape:state', playerStateOf(v, playerId));
    }
    this.toHost(ref, v);
    this.toBoard(ref, v);
  }

  private toHost(ref: RunRef, v: RunView): void {
    this.server.to(escapeRooms.host(ref.pin)).emit('escape:host', hostStateOf(v));
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
    const now = Date.now();
    const last = this.boards.get(ref.pin);
    const wait = last ? last.at + this.timings.boardEveryMs - now : 0;
    if (wait <= 0) {
      this.boards.set(ref.pin, { at: now, timer: null });
      this.emitBoard(ref.pin, v);
      return;
    }
    if (last!.timer) return;
    last!.timer = setTimeout(() => {
      last!.timer = null;
      void this.boardNow(ref.pin).catch((err: Error) =>
        this.log.warn(`board ${ref.pin}: ${err.message}`),
      );
    }, wait);
    last!.timer.unref?.();
  }

  private async boardNow(pin: string): Promise<void> {
    const meta = await this.game.getMeta(pin);
    if (meta?.kind !== 'escape') return;
    const ref = await this.requireRun(pin);
    this.boards.set(pin, { at: Date.now(), timer: null });
    this.emitBoard(pin, await this.viewOf(ref));
  }

  private emitBoard(pin: string, v: RunView): void {
    this.server
      .to([escapeRooms.board(pin), escapeRooms.host(pin)])
      .emit('escape:board', boardOf(v));
  }
}
