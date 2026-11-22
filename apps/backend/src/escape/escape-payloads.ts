/**
 * Outbound escape payloads (M3 plan §2). The leak boundary: phones get
 * EscapePlayerState, whose `view` always comes from playerView; screens get
 * counts, names and stage titles; answers leave only in the host's outline.
 * Fields are copied one by one: no template object is ever spread.
 */

import type {
  EscapeAnnounce,
  EscapeBoard,
  EscapeClock,
  EscapeFinale,
  EscapeFormation,
  EscapeHostState,
  EscapeHostTeam,
  EscapeMember,
  EscapeOutline,
  EscapePlayerState,
  EscapeTeamClock,
  EscapeTeamSummary,
  EscapeTeamUpdate,
} from '@quiz-dock/contracts';
import { deadlineAt, remainingMs, runElapsed, stageOpenedAt } from './escape-clock';
import type { EscapeRun, EscapeSnapshot, TeamRecord } from './escape-live.types';
import { awards, nextHint, playerView, rankTeams } from './escape-rules';
import type { EscapeTemplate, Lock, Stage, SubmitResult, TeamState } from './escape.types';

/** A player of the room, as the engine sees it (R1 decides `connected`). */
export interface RoomPlayer {
  playerId: string;
  nickname: string;
  avatar: string | null;
  connected: boolean;
}

/** Everything a payload is built from, read once per change. */
export interface RunView {
  /** The run's game id (meta.id). */
  id: string;
  snap: EscapeSnapshot;
  run: EscapeRun;
  /** Team records in display order (run.teamIds). */
  teams: TeamRecord[];
  /** The room's players in join order. */
  players: RoomPlayer[];
  now: number;
}

const own = <T>(rec: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(rec, key) ? rec[key] : undefined;

const elapsedOf = (v: RunView) => runElapsed(v.run.clock, v.now);

const currentStage = (tpl: EscapeTemplate, team: TeamState): Stage =>
  tpl.stages[Math.min(team.stageIndex, tpl.stages.length - 1)];

export function clockOf(v: RunView): EscapeClock {
  return {
    serverNow: v.now,
    paused: !!v.run.clock.pausedAt,
    elapsedMs: elapsedOf(v),
    limitMs: v.run.clock.limitMs,
  };
}

function teamClockOf(v: RunView, rec: TeamRecord): EscapeTeamClock {
  return {
    remainingMs: remainingMs(v.run.clock, rec.team, elapsedOf(v)),
    deadlineAt: rec.timedOut ? null : deadlineAt(v.run.clock, rec.team, v.now),
  };
}

export function formationOf(v: RunView): EscapeFormation {
  return {
    mode: v.run.formation,
    maxSize: v.run.maxSize || null,
    teams: v.teams.map((r) => ({
      id: r.team.id,
      name: r.team.name,
      memberCount: r.team.members.length,
    })),
  };
}

function membersOf(v: RunView, team: TeamState): EscapeMember[] {
  const byId = new Map(v.players.map((p) => [p.playerId, p]));
  return team.members.map((id) => {
    const p = byId.get(id);
    return {
      playerId: id,
      nickname: p?.nickname ?? '',
      avatar: p?.avatar ?? null,
      connected: p?.connected ?? false,
      roles: [...(own(team.roles, id) ?? [])],
    };
  });
}

const recOf = (v: RunView, playerId: string) =>
  v.teams.find((r) => r.team.members.includes(playerId)) ?? null;

/** To one phone. */
export function playerStateOf(v: RunView, playerId: string): EscapePlayerState {
  const tpl = v.snap.template;
  const rec = recOf(v, playerId);
  const live = v.run.phase === 'running';
  const playing =
    v.run.phase === 'running' && rec !== null && rec.team.escapedAt === null && !rec.timedOut;
  const hint = playing ? nextHint(tpl, rec.team) : null;
  return {
    gameId: v.id,
    phase: v.run.phase,
    clock: clockOf(v),
    title: tpl.title,
    intro: tpl.intro,
    roles: tpl.roles.map((r) => ({ id: r.id, name: r.name, description: r.description })),
    formation: formationOf(v),
    team: rec && {
      ...teamClockOf(v, rec),
      id: rec.team.id,
      name: rec.team.name,
      members: membersOf(v, rec.team),
      stageIndex: rec.team.stageIndex,
      stageCount: tpl.stages.length,
      escaped: rec.team.escapedAt !== null,
      escapedMs: rec.team.escapedAt,
      timedOut: rec.timedOut,
      hintPenaltyS: rec.team.hintPenaltyS,
    },
    view: live && rec ? playerView(tpl, rec.team, playerId) : null,
    nextHint: hint && { id: hint.id, penaltyS: hint.penaltyS },
  };
}

/** One team on the big screen: counts and titles, no secrets. */
export function teamSummaryOf(v: RunView, rec: TeamRecord): EscapeTeamSummary {
  const tpl = v.snap.template;
  const { team } = rec;
  const stage = currentStage(tpl, team);
  const members = membersOf(v, team);
  return {
    id: team.id,
    name: team.name,
    memberCount: members.length,
    connectedCount: members.filter((m) => m.connected).length,
    stageIndex: team.stageIndex,
    stageCount: tpl.stages.length,
    stageTitle: stage.title,
    locksSolved: team.solved.length,
    locksTotal: stage.locks.length,
    hintsUsed: team.hintsUsed.length,
    escaped: team.escapedAt !== null,
    timedOut: rec.timedOut,
    ...teamClockOf(v, rec),
  };
}

const unassignedOf = (v: RunView) => v.players.filter((p) => !recOf(v, p.playerId));

export function boardOf(v: RunView): EscapeBoard {
  return {
    phase: v.run.phase,
    clock: clockOf(v),
    title: v.snap.template.title,
    teams: v.teams.map((r) => teamSummaryOf(v, r)),
    unassigned: unassignedOf(v).length,
  };
}

export function announceOf(kind: EscapeAnnounce['kind'], team: TeamState): EscapeAnnounce {
  return {
    kind,
    teamId: team.id,
    teamName: team.name,
    // The team has moved on when it cleared a stage: announce the stage it cleared.
    stageIndex: kind === 'stage-cleared' ? team.stageIndex - 1 : team.stageIndex,
  };
}

/**
 * What a submit (or a host unlock, `by` null) did, for the team's phones and
 * the host; null when refused. Wrong answers and parts only ever come from a
 * player, so their `by` is a player id.
 */
export function submitUpdateOf(
  tpl: EscapeTemplate,
  teamId: string,
  result: SubmitResult,
  by: string | null,
  roleId?: string,
): EscapeTeamUpdate | null {
  switch (result.outcome) {
    case 'wrong':
      return { teamId, kind: 'wrong', by: by ?? '' };
    case 'part-accepted':
      return {
        teamId,
        kind: 'part-accepted',
        lockId: result.lockId,
        roleId: roleId ?? '',
        by: by ?? '',
      };
    case 'lock-solved':
      return { teamId, kind: 'lock-solved', lockId: result.lockId, by };
    case 'stage-cleared':
      return {
        teamId,
        kind: 'stage-cleared',
        stageIndex: result.stageIndex,
        unlockText: tpl.stages[result.stageIndex].unlockText,
        by,
      };
    case 'escaped':
      return { teamId, kind: 'escaped', unlockText: tpl.stages.at(-1)!.unlockText, by };
    case 'refused':
      return null;
  }
}

/** A hint released: its id only, the text goes in the team's `view.hints`. */
export function hintUpdateOf(
  teamId: string,
  hintId: string,
  source: 'request' | 'timer' | 'host',
): EscapeTeamUpdate {
  return { teamId, kind: 'hint', hintId, source };
}

export function timeUpOf(teamId: string): EscapeTeamUpdate {
  return { teamId, kind: 'time-up' };
}

const copyRecord = (rec: Record<string, string[]>): Record<string, string[]> =>
  Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, [...v]]));

export function hostTeamOf(v: RunView, rec: TeamRecord): EscapeHostTeam {
  const { team } = rec;
  return {
    ...teamSummaryOf(v, rec),
    members: membersOf(v, team),
    solved: [...team.solved],
    partsDone: copyRecord(team.parts),
    wrong: team.wrong,
    hintIds: [...team.hintsUsed],
    hintPenaltyS: team.hintPenaltyS,
    adjustMs: team.adjustMs,
    hostUnlocks: [...team.hostUnlocks],
    solvesBy: Object.fromEntries(Object.entries(team.solvesBy)),
    stageClearedAt: [...team.stageClearedAt],
    lastProgressAt: rec.lastProgressAt,
    stuck: rec.stuck,
    timeOnStageMs:
      team.escapedAt !== null || v.run.phase === 'forming'
        ? 0
        : Math.max(0, elapsedOf(v) - stageOpenedAt(team)),
  };
}

export function hostStateOf(v: RunView): EscapeHostState {
  return {
    board: boardOf(v),
    formation: formationOf(v),
    teams: v.teams.map((r) => hostTeamOf(v, r)),
    unassigned: unassignedOf(v).map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      connected: p.connected,
    })),
    templateVersion: v.snap.version,
  };
}

function copyLock(l: Lock): Lock {
  const base = { id: l.id, label: l.label };
  switch (l.kind) {
    case 'code':
      return { ...base, kind: 'code', answer: l.answer };
    case 'phrase':
      return { ...base, kind: 'phrase', answers: [...l.answers] };
    case 'choice':
      return {
        ...base,
        kind: 'choice',
        options: l.options.map(({ id, label, image }) => ({ id, label, image })),
        correct: [...l.correct],
      };
    case 'sequence':
      return {
        ...base,
        kind: 'sequence',
        items: l.items.map(({ id, label }) => ({ id, label })),
        order: [...l.order],
      };
    case 'combined':
      return {
        ...base,
        kind: 'combined',
        parts: l.parts.map(({ roleId, answer }) => ({ roleId, answer })),
      };
  }
}

/** The frozen template with its answers, for the host console only. */
export function outlineOf(snap: EscapeSnapshot): EscapeOutline {
  const t = snap.template;
  return {
    templateId: snap.templateId,
    version: snap.version,
    template: {
      id: t.id,
      title: t.title,
      intro: t.intro,
      difficulty: t.difficulty,
      targetMinutes: t.targetMinutes,
      mode: t.mode,
      roles: t.roles.map(({ id, name, description }) => ({ id, name, description })),
      stages: t.stages.map((s) => ({
        id: s.id,
        title: s.title,
        intro: s.intro,
        locks: s.locks.map(copyLock),
        clues: s.clues.map(({ id, roleId, kind, body }) => ({ id, roleId, kind, body })),
        hints: s.hints.map(({ id, text, penaltyS, releaseAfterS }) => ({
          id,
          text,
          penaltyS,
          releaseAfterS,
        })),
        unlockText: s.unlockText,
      })),
      finale: t.finale,
    },
  };
}

/** Ranking and awards of every team; members by nickname. */
/** `gameId`: the run's, for `escape:results`. */
export function finaleOf(v: RunView, gameId: string): EscapeFinale {
  const tpl = v.snap.template;
  const teams = v.teams.map((r) => r.team);
  const names = new Map(v.players.map((p) => [p.playerId, p.nickname]));
  const a = awards(teams);
  return {
    gameId,
    title: tpl.title,
    finale: tpl.finale,
    ranking: rankTeams(teams).map(({ team, place, scoreMs }) => ({
      teamId: team.id,
      name: team.name,
      place,
      scoreMs,
      escaped: team.escapedAt !== null,
      stagesCleared: team.stageClearedAt.length,
      stageClearedAt: [...team.stageClearedAt],
      hintsUsed: team.hintsUsed.length,
      paidHints: team.paidHints.length,
      hintPenaltyS: team.hintPenaltyS,
      adjustMs: team.adjustMs,
      hostUnlocks: team.hostUnlocks.length,
      members: team.members.map((id) => names.get(id) ?? ''),
    })),
    awards: {
      fastest: a.fastest,
      fewestHints: a.fewestHints,
      teamwork: a.teamwork,
      photoFinish: a.photoFinish && [a.photoFinish[0], a.photoFinish[1]],
    },
  };
}
