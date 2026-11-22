import { normalizeAnswer, type EscapePlayerView } from '@quiz-dock/contracts';
import type {
  Clue,
  EscapeTemplate,
  Hint,
  Lock,
  LockInput,
  Same,
  SequenceLock,
  SubmitResult,
  TeamState,
} from './escape.types';

/** Decomposes (NFD) and drops combining marks, as `normalizeAnswer` does: "été" is "ete". */
export function stripDiacritics(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Codes compare on letters and digits only, upper case: "a-17 b" is "A17B", "été" is "ETE". */
export function normalizeCode(text: string): string {
  return stripDiacritics(text)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
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
 * Initial assignment: round-robin over the connected members. Fewer members
 * than roles: some hold several. More: some roles are shared. Later changes
 * go through reassignRoles.
 */
export function assignRoles(memberIds: string[], roleIds: string[]): Record<string, string[]> {
  if (!memberIds.length) return {};
  // Built in a Map so an id like "__proto__" stays an ordinary key.
  const out = new Map<string, string[]>(memberIds.map((id) => [id, []]));
  const slots = Math.max(memberIds.length, roleIds.length);
  for (let i = 0; i < slots; i++) {
    const held = out.get(memberIds[i % memberIds.length])!;
    const role = roleIds[i % roleIds.length];
    if (role && !held.includes(role)) held.push(role);
  }
  return Object.fromEntries(out);
}

/**
 * Sticky reassignment when members connect or leave. Connected members keep
 * their roles; a role left without a connected holder goes to the connected
 * member holding the fewest (earlier in `connected` on ties); a member with no
 * role shares the latest role of the most loaded holder (for a rejoiner, often
 * the role they left), or `roleIds[0]` when everyone holds as many.
 * Disconnected members are dropped.
 */
export function reassignRoles(
  prev: Record<string, string[]>,
  connected: string[],
  roleIds: string[],
): Record<string, string[]> {
  const known = new Set(roleIds);
  // A Map, so ids like "__proto__" stay plain keys.
  const held = new Map<string, string[]>(
    connected.map((m) => [m, Object.hasOwn(prev, m) ? prev[m].filter((r) => known.has(r)) : []]),
  );
  if (!held.size) return {};
  const leastLoaded = () =>
    [...held.keys()].reduce((a, b) => (held.get(b)!.length < held.get(a)!.length ? b : a));
  for (const role of roleIds) {
    if (![...held.values()].some((rs) => rs.includes(role))) {
      const m = leastLoaded();
      held.set(m, [...held.get(m)!, role]);
    }
  }
  const holders = [...held.entries()].filter(([, rs]) => rs.length);
  const counts = holders.map(([, rs]) => rs.length);
  const allEqual = counts.every((c) => c === counts[0]);
  const busiest = holders.find(([, rs]) => rs.length === Math.max(...counts));
  const shared = allEqual ? roleIds[0] : busiest?.[1].at(-1);
  if (shared !== undefined) {
    for (const [m, rs] of held) if (!rs.length) held.set(m, [shared]);
  }
  return Object.fromEntries(held);
}

/** Own properties only, so ids like "constructor" never reach Object.prototype. */
const own = <T>(rec: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(rec, key) ? rec[key] : undefined;

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
    paidHints: [],
    hintPenaltyS: 0,
    adjustMs: 0,
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
  if (!team.members.includes(s.playerId)) return refuse('not-a-member');
  const lock = tpl.stages[team.stageIndex]?.locks.find((l) => l.id === s.lockId);
  if (!lock) return refuse('unknown-lock');
  if (team.solved.includes(lock.id)) return refuse('already-solved');
  const credit = (t: TeamState) => ({
    ...t,
    solvesBy: { ...t.solvesBy, [s.playerId]: (own(t.solvesBy, s.playerId) ?? 0) + 1 },
  });
  const wrong = () => ({
    team: { ...team, wrong: team.wrong + 1 },
    result: { outcome: 'wrong' } as SubmitResult,
  });

  if (lock.kind === 'combined') {
    if (typeof s.input !== 'string' || !s.roleId) return refuse('bad-input');
    const part = lock.parts.find((p) => p.roleId === s.roleId);
    if (!part || !(own(team.roles, s.playerId) ?? []).includes(s.roleId)) {
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

/**
 * Uses the next unused hint of the current stage; anything else leaves the
 * team unchanged. `free` (a timed release) shows the hint without its penalty
 * and without counting it as paid.
 */
export function useHint(
  tpl: EscapeTemplate,
  team: TeamState,
  hintId: string,
  opts: { free?: boolean } = {},
): TeamState {
  if (team.escapedAt !== null) return team;
  const hint = nextHint(tpl, team);
  if (!hint || hint.id !== hintId) return team;
  const hintsUsed = [...team.hintsUsed, hintId];
  if (opts.free) return { ...team, hintsUsed };
  return {
    ...team,
    hintsUsed,
    paidHints: [...team.paidHints, hintId],
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

/** The host gives a team `deltaMs` (negative takes time away); see TeamState.adjustMs. */
export function adjustTime(team: TeamState, deltaMs: number): TeamState {
  return { ...team, adjustMs: team.adjustMs + deltaMs };
}

/** The team's own time limit in run ms: the run's duration plus the host's adjustments. */
export function deadlineMs(durationMs: number, team: TeamState): number {
  return durationMs + team.adjustMs;
}

/**
 * FNV-1a, 32 bit, then the murmur3 finaliser: a small pure hash for a stable
 * order. Without the finaliser, ids that differ in their last character only
 * ("s1".."s6") came out sorted or reversed in about one seed in four.
 */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Items in a stable hash order of `seed`: stable across reconnects, independent
 * of the authored order. It may equal the answer by chance, like any shuffle;
 * never force it away from the answer, since that would leak. Never sort by id
 * or label instead: authors may write those in order too.
 */
export function hashOrder(
  items: readonly { id: string; label: string }[],
  seed: string,
): { id: string; label: string }[] {
  return items
    .map(({ id, label }) => ({ id, label, h: fnv1a(`${seed}:${id}`) }))
    .sort((a, b) => a.h - b.h || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ id, label }) => ({ id, label }));
}

/** Per-team hash order of a sequence lock's items (see hashOrder). */
function shuffledItems(lock: SequenceLock, teamId: string): { id: string; label: string }[] {
  return hashOrder(lock.items, teamId);
}

export interface PlayerLockView {
  id: string;
  label: string;
  kind: Lock['kind'];
  solved: boolean;
  options?: { id: string; label: string; image: string | null }[];
  /** Sequence items in a stable per-team hash order (see shuffledItems). */
  items?: { id: string; label: string }[];
  /** Combined: every role with a part (role names are public), the ones this player may enter, and which are in. */
  partRoles?: string[];
  myParts?: string[];
  partsDone?: string[];
  /** Code: the answer is digits only, so the phone may show a number pad. */
  digits?: true;
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

/** Compile-time check: the socket contract's EscapePlayerView is exactly PlayerView. */
export const playerViewMatchesContract: Same<PlayerView, EscapePlayerView> = true;

/**
 * Everything one phone may know. This is the security boundary: no answers
 * (answer, answers, correct, order, combined part answers), no clues of roles
 * the player does not hold, no unused hints. Fields are copied one by one so
 * nothing extra in authored data can leak.
 */
export function playerView(tpl: EscapeTemplate, team: TeamState, playerId: string): PlayerView {
  const stage = tpl.stages[Math.min(team.stageIndex, tpl.stages.length - 1)];
  const roles = [...(own(team.roles, playerId) ?? [])];
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
        case 'code':
          // Says only "digits", as a real padlock does; separators are dropped when checking.
          return /^\d+$/.test(normalizeCode(l.answer)) ? { ...base, digits: true } : base;
        case 'combined':
          return {
            ...base,
            partRoles: l.parts.map((p) => p.roleId),
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

export interface Ranked {
  team: TeamState;
  place: number;
  /** Escaped: time in ms including paid hint penalties. Host adjustments do not count. */
  scoreMs: number | null;
}

const scoreMs = (t: TeamState) =>
  t.escapedAt === null ? null : t.escapedAt + t.hintPenaltyS * 1000;

const byId = (a: TeamState, b: TeamState) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Escaped teams first by time plus hint penalties; the rest by stage reached,
 * then by when they cleared their last stage. Equal teams by id, so stable.
 */
export function rankTeams(teams: TeamState[]): Ranked[] {
  const sorted = [...teams].sort((a, b) => {
    const sa = scoreMs(a);
    const sb = scoreMs(b);
    if (sa !== null || sb !== null) {
      if (sa === null) return 1;
      if (sb === null) return -1;
      return sa - sb || byId(a, b);
    }
    if (a.stageIndex !== b.stageIndex) return b.stageIndex - a.stageIndex;
    const la = a.stageClearedAt.at(-1) ?? Infinity;
    const lb = b.stageClearedAt.at(-1) ?? Infinity;
    return la === lb ? byId(a, b) : la - lb;
  });
  return sorted.map((team, i) => ({ team, place: i + 1, scoreMs: scoreMs(team) }));
}

/** Evenness of contribution: 1 when every member solved as much, 0 when one did all. */
function evenness(t: TeamState): number {
  const counts = t.members.map((m) => own(t.solvesBy, m) ?? 0);
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total || counts.length < 2) return 0;
  return 1 - (Math.max(...counts) - Math.min(...counts)) / total;
}

export interface Awards {
  fastest: string | null;
  fewestHints: string | null;
  /** Most even contribution; null when no team has any spread. */
  teamwork: string | null;
  /** The two escaped teams with the smallest gap between them. */
  photoFinish: [string, string] | null;
}

export function awards(teams: TeamState[]): Awards {
  const escaped = rankTeams(teams).filter((r) => r.scoreMs !== null);
  const fastest = escaped[0]?.team.id ?? null;
  // Paid hints only (timed ones are free). Stable sort: equal counts go to the better place.
  const fewestHints =
    [...escaped].sort((a, b) => a.team.paidHints.length - b.team.paidHints.length)[0]?.team.id ??
    null;
  const best = [...teams]
    .map((team) => ({ team, e: evenness(team) }))
    .sort((a, b) => b.e - a.e || byId(a.team, b.team))[0];
  const teamwork = best && best.e > 0 ? best.team.id : null;
  let photoFinish: [string, string] | null = null;
  let bestGap = Infinity;
  for (let i = 1; i < escaped.length; i++) {
    const gap = escaped[i].scoreMs! - escaped[i - 1].scoreMs!;
    if (gap < bestGap) {
      bestGap = gap;
      photoFinish = [escaped[i - 1].team.id, escaped[i].team.id];
    }
  }
  return { fastest, fewestHints, teamwork, photoFinish };
}
