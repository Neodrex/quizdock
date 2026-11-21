import { normalizeAnswer } from '@quiz-dock/contracts';
import type {
  Clue,
  EscapeTemplate,
  Hint,
  Lock,
  LockInput,
  SequenceLock,
  SubmitResult,
  TeamState,
} from './escape.types';

/** Codes compare on letters and digits only, upper case: "a-17 b" is "A17B". */
export function normalizeCode(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Same elements, no duplicates in `a`, order ignored. */
const sameSet = (a: string[], b: string[]) => {
  const set = new Set(a);
  return set.size === a.length && a.length === b.length && b.every((x) => set.has(x));
};

/** Whether `input` opens `lock`. Combined locks are checked per part by `submit`. */
export function checkAnswer(lock: Lock, input: LockInput): boolean {
  switch (lock.kind) {
    case 'code':
      return typeof input === 'string' && normalizeCode(input) === normalizeCode(lock.answer);
    case 'phrase':
      return (
        typeof input === 'string' &&
        lock.answers.some((a) => normalizeAnswer(a) === normalizeAnswer(input))
      );
    case 'choice':
      return Array.isArray(input) && sameSet(input, lock.correct);
    case 'sequence':
      return (
        Array.isArray(input) &&
        input.length === lock.order.length &&
        input.every((id, i) => id === lock.order[i])
      );
    case 'combined':
      return false;
  }
}

/**
 * Round-robin over the connected members. Fewer members than roles: some hold
 * several. More: some roles are shared. Called again when someone leaves, so a
 * role is never left without a player.
 */
export function assignRoles(memberIds: string[], roleIds: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!memberIds.length) return out;
  for (const id of memberIds) out[id] = [];
  const slots = Math.max(memberIds.length, roleIds.length);
  for (let i = 0; i < slots; i++) {
    const member = memberIds[i % memberIds.length];
    const role = roleIds[i % roleIds.length];
    if (role && !out[member].includes(role)) out[member].push(role);
  }
  return out;
}

export function newTeam(
  tpl: EscapeTemplate,
  id: string,
  name: string,
  members: string[],
): TeamState {
  return {
    id,
    name,
    members,
    roles:
      tpl.mode === 'roles'
        ? assignRoles(
            members,
            tpl.roles.map((r) => r.id),
          )
        : {},
    stageIndex: 0,
    solved: [],
    parts: {},
    wrong: 0,
    hintsUsed: [],
    hintPenaltyS: 0,
    stageClearedAt: [],
    escapedAt: null,
    hostUnlocks: [],
    solvesBy: {},
  };
}

export interface Submission {
  playerId: string;
  lockId: string;
  /** Combined locks: which of the player's roles this part is for. */
  roleId?: string;
  input: LockInput;
}

/** Marks `lockId` solved and moves the team on if that cleared the stage. */
function solveLock(
  tpl: EscapeTemplate,
  team: TeamState,
  lockId: string,
  at: number,
): { team: TeamState; result: SubmitResult } {
  const stage = tpl.stages[team.stageIndex];
  const solved = [...team.solved, lockId];
  if (!stage.locks.every((l) => solved.includes(l.id))) {
    return { team: { ...team, solved }, result: { outcome: 'lock-solved', lockId } };
  }
  const stageClearedAt = [...team.stageClearedAt, at];
  if (team.stageIndex === tpl.stages.length - 1) {
    return {
      team: { ...team, solved, stageClearedAt, escapedAt: at },
      result: { outcome: 'escaped' },
    };
  }
  return {
    team: { ...team, stageIndex: team.stageIndex + 1, solved: [], parts: {}, stageClearedAt },
    result: { outcome: 'stage-cleared', stageIndex: team.stageIndex },
  };
}

export function submit(
  tpl: EscapeTemplate,
  team: TeamState,
  s: Submission,
  at: number,
): { team: TeamState; result: SubmitResult } {
  const refuse = (reason: Extract<SubmitResult, { outcome: 'refused' }>['reason']) => ({
    team,
    result: { outcome: 'refused', reason } as SubmitResult,
  });
  if (team.escapedAt !== null) return refuse('escaped');
  const lock = tpl.stages[team.stageIndex].locks.find((l) => l.id === s.lockId);
  if (!lock) return refuse('unknown-lock');
  if (team.solved.includes(lock.id)) return refuse('already-solved');
  const credit = (t: TeamState) => ({
    ...t,
    solvesBy: { ...t.solvesBy, [s.playerId]: (t.solvesBy[s.playerId] ?? 0) + 1 },
  });
  const wrong = () => ({
    team: { ...team, wrong: team.wrong + 1 },
    result: { outcome: 'wrong' } as SubmitResult,
  });

  if (lock.kind === 'combined') {
    if (typeof s.input !== 'string' || !s.roleId) return refuse('bad-input');
    const part = lock.parts.find((p) => p.roleId === s.roleId);
    if (!part || !(team.roles[s.playerId] ?? []).includes(s.roleId)) {
      return refuse('not-your-part');
    }
    const entered = team.parts[lock.id] ?? [];
    // A part already entered must not be credited (or counted wrong) again.
    if (entered.includes(s.roleId)) return refuse('already-solved');
    if (normalizeAnswer(part.answer) !== normalizeAnswer(s.input)) return wrong();
    const done = [...entered, s.roleId];
    const next = credit({ ...team, parts: { ...team.parts, [lock.id]: done } });
    if (!lock.parts.every((p) => done.includes(p.roleId))) {
      return { team: next, result: { outcome: 'part-accepted', lockId: lock.id } };
    }
    return solveLock(tpl, next, lock.id, at);
  }

  if (!checkAnswer(lock, s.input)) return wrong();
  return solveLock(tpl, credit(team), lock.id, at);
}

/** The first unused hint of the team's current stage, or null. */
export function nextHint(tpl: EscapeTemplate, team: TeamState): Hint | null {
  return tpl.stages[team.stageIndex]?.hints.find((h) => !team.hintsUsed.includes(h.id)) ?? null;
}

/** Uses a hint of the current stage once; anything else leaves the team unchanged. */
export function useHint(tpl: EscapeTemplate, team: TeamState, hintId: string): TeamState {
  const hint = tpl.stages[team.stageIndex]?.hints.find((h) => h.id === hintId);
  if (!hint || team.hintsUsed.includes(hintId)) return team;
  return {
    ...team,
    hintsUsed: [...team.hintsUsed, hintId],
    hintPenaltyS: team.hintPenaltyS + hint.penaltyS,
  };
}

/** The host opens a lock for a stuck team; nobody is credited, the results show it. */
export function hostUnlock(
  tpl: EscapeTemplate,
  team: TeamState,
  lockId: string,
  at: number,
): { team: TeamState; result: SubmitResult } {
  const refuse = (reason: Extract<SubmitResult, { outcome: 'refused' }>['reason']) => ({
    team,
    result: { outcome: 'refused', reason } as SubmitResult,
  });
  if (team.escapedAt !== null) return refuse('escaped');
  const lock = tpl.stages[team.stageIndex]?.locks.find((l) => l.id === lockId);
  if (!lock) return refuse('unknown-lock');
  if (team.solved.includes(lockId)) return refuse('already-solved');
  return solveLock(tpl, { ...team, hostUnlocks: [...team.hostUnlocks, lockId] }, lockId, at);
}

/** FNV-1a, 32 bit: a small pure hash for a stable per-team order. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Per-team hash order: stable across reconnects, independent of the authored
 * order. It may equal the answer by chance, like any shuffle; never force it
 * away from the answer, since that would leak.
 */
function shuffledItems(lock: SequenceLock, teamId: string): { id: string; label: string }[] {
  return lock.items
    .map(({ id, label }) => ({ id, label, h: fnv1a(`${teamId}:${id}`) }))
    .sort((a, b) => a.h - b.h || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ id, label }) => ({ id, label }));
}

export interface PlayerLockView {
  id: string;
  label: string;
  kind: Lock['kind'];
  solved: boolean;
  options?: { id: string; label: string; image: string | null }[];
  /** Sequence items in a stable per-team hash order (see shuffledItems). */
  items?: { id: string; label: string }[];
  /** Combined: the role ids this player may enter, and which parts are already in. */
  myParts?: string[];
  partsDone?: string[];
}

export interface PlayerView {
  stageIndex: number;
  stageCount: number;
  title: string;
  intro: string;
  roles: string[];
  clues: Clue[];
  locks: PlayerLockView[];
  hints: { id: string; text: string }[];
  escaped: boolean;
}

/**
 * Everything one phone may know. This is the security boundary: no answers
 * (answer, answers, correct, order, combined part answers), no clues of roles
 * the player does not hold, no unused hints. Fields are copied one by one so
 * nothing extra in authored data can leak.
 */
export function playerView(tpl: EscapeTemplate, team: TeamState, playerId: string): PlayerView {
  const stage = tpl.stages[Math.min(team.stageIndex, tpl.stages.length - 1)];
  const roles = [...(team.roles[playerId] ?? [])];
  return {
    stageIndex: team.stageIndex,
    stageCount: tpl.stages.length,
    title: stage.title,
    intro: stage.intro,
    roles,
    clues: stage.clues
      .filter((c) => c.roleId === null || roles.includes(c.roleId))
      .map(({ id, roleId, kind, body }) => ({ id, roleId, kind, body })),
    locks: stage.locks.map((l): PlayerLockView => {
      const base = { id: l.id, label: l.label, kind: l.kind, solved: team.solved.includes(l.id) };
      switch (l.kind) {
        case 'choice':
          return {
            ...base,
            options: l.options.map(({ id, label, image }) => ({ id, label, image })),
          };
        case 'sequence':
          return { ...base, items: shuffledItems(l, team.id) };
        case 'combined':
          return {
            ...base,
            myParts: l.parts.map((p) => p.roleId).filter((r) => roles.includes(r)),
            partsDone: [...(team.parts[l.id] ?? [])],
          };
        default:
          return base;
      }
    }),
    hints: stage.hints
      .filter((h) => team.hintsUsed.includes(h.id))
      .map(({ id, text }) => ({ id, text })),
    escaped: team.escapedAt !== null,
  };
}
