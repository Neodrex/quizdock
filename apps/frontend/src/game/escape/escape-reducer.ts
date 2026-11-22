import type {
  EscapeAskHintAck,
  EscapeFinale,
  EscapePlayerState,
  EscapeSubmitAck,
  EscapeTeamUpdate,
} from '@quiz-dock/contracts';

/**
 * The phone's escape state, pure: server events in, what to show and say out. It only
 * ever holds what the phone was sent (EscapePlayerState, EscapeTeamUpdate, EscapeFinale),
 * so it has no answers to leak.
 */

/** A message for the announcer: a key of the `escape` namespace and its params. */
export interface Announcement {
  /** Unique per message, so the same text said twice is spoken twice. */
  id: number;
  key: string;
  params?: Record<string, string | number>;
}

export type Overlay =
  | { kind: 'stage'; unlockText: string; stageIndex: number }
  | { kind: 'escaped'; unlockText: string };

export interface EscapeUi {
  state: EscapePlayerState | null;
  finale: EscapeFinale | null;
  overlay: Overlay | null;
  /** Polite messages, oldest first; the announcer speaks the ones it has not yet. */
  polite: Announcement[];
  /** The latest timer warning, or time up. */
  assertive: Announcement | null;
  /** `waiting`: the room ended before the finale came (§1.4). */
  ended: 'none' | 'waiting' | 'final';
  /** Released hints known to be free (timed) or paid, from the update that brought them. */
  hintTags: Record<string, 'free' | 'paid'>;
  /** The next announcement's id. */
  seq: number;
}

export type EscapeAction =
  | { type: 'state'; state: EscapePlayerState }
  | { type: 'teamUpdate'; update: EscapeTeamUpdate; me: string | null }
  | { type: 'finale'; finale: EscapeFinale }
  | { type: 'gameEnded' }
  | { type: 'finaleTimeout' }
  | { type: 'submitAck'; lockId: string; ack: EscapeSubmitAck }
  | { type: 'hintAck'; ack: EscapeAskHintAck }
  | { type: 'clockWarning'; minutes: number }
  | { type: 'dismissOverlay' };

export const initialEscapeUi: EscapeUi = {
  state: null,
  finale: null,
  overlay: null,
  polite: [],
  assertive: null,
  ended: 'none',
  hintTags: {},
  seq: 1,
};

/** Polite messages kept: the announcer has long spoken older ones. */
const POLITE_KEPT = 20;

function say(ui: EscapeUi, key: string, params?: Announcement['params']): EscapeUi {
  const msg: Announcement = { id: ui.seq, key, ...(params ? { params } : {}) };
  return { ...ui, seq: ui.seq + 1, polite: [...ui.polite, msg].slice(-POLITE_KEPT) };
}

function shout(ui: EscapeUi, key: string, params?: Announcement['params']): EscapeUi {
  const msg: Announcement = { id: ui.seq, key, ...(params ? { params } : {}) };
  return { ...ui, seq: ui.seq + 1, assertive: msg };
}

/** "+2:00" or "−1:00" (a real minus sign). */
export function formatDelta(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  const mmss = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return `${ms < 0 ? '−' : '+'}${mmss}`;
}

const nicknameOf = (s: EscapePlayerState, playerId: string) =>
  s.team?.members.find((m) => m.playerId === playerId)?.nickname ?? '?';
const lockLabel = (s: EscapePlayerState, lockId: string) =>
  s.view?.locks.find((l) => l.id === lockId)?.label ?? '';
const roleName = (s: EscapePlayerState, roleId: string) =>
  s.roles.find((r) => r.id === roleId)?.name ?? roleId;

function onState(ui: EscapeUi, next: EscapePlayerState): EscapeUi {
  const prev = ui.state;
  // A new game in the same room: nothing of the last one carries over.
  if (prev && prev.gameId !== next.gameId) {
    return { ...initialEscapeUi, seq: ui.seq, state: next };
  }
  let out: EscapeUi = { ...ui, state: next };
  if (!prev) return out;
  if (prev.phase === 'forming' && next.phase === 'running') out = say(out, 'announce.started');
  if (prev.phase === 'running' && next.phase === 'running') {
    if (!prev.clock.paused && next.clock.paused) out = say(out, 'announce.paused');
    if (prev.clock.paused && !next.clock.paused) out = say(out, 'announce.resumed');
  }
  const before = prev.view?.roles;
  const after = next.view?.roles;
  if (before && after && before.join() !== after.join()) {
    out = say(out, 'announce.rolesChanged', {
      roles: after.map((r) => roleName(next, r)).join(', '),
    });
  }
  return out;
}

function onTeamUpdate(ui: EscapeUi, u: EscapeTeamUpdate, me: string | null): EscapeUi {
  const s = ui.state;
  if (!s?.team || s.team.id !== u.teamId) return ui;
  switch (u.kind) {
    case 'wrong':
      // My own wrong try shows on my lock, from the ack.
      return u.by === me ? ui : say(ui, 'announce.teammateWrong', { by: nicknameOf(s, u.by) });
    case 'part-accepted':
      return say(ui, 'announce.partAccepted', {
        lock: lockLabel(s, u.lockId),
        role: roleName(s, u.roleId),
        by: nicknameOf(s, u.by),
      });
    case 'lock-solved':
      return u.by === null
        ? say(ui, 'announce.lockSolvedByHost', { lock: lockLabel(s, u.lockId) })
        : say(ui, 'announce.lockSolved', { lock: lockLabel(s, u.lockId), by: nicknameOf(s, u.by) });
    case 'stage-cleared':
      return say(
        { ...ui, overlay: { kind: 'stage', unlockText: u.unlockText, stageIndex: u.stageIndex } },
        'announce.stageCleared',
        { text: u.unlockText },
      );
    case 'escaped':
      return say(
        { ...ui, overlay: { kind: 'escaped', unlockText: u.unlockText } },
        'announce.escaped',
        { text: u.unlockText },
      );
    case 'hint': {
      if (u.source === 'timer') {
        return say(
          { ...ui, hintTags: { ...ui.hintTags, [u.hintId]: 'free' } },
          'announce.hintFree',
        );
      }
      // The cost is the one offered before this hint came: the state that follows offers the next.
      const penaltyS = s.nextHint?.id === u.hintId ? s.nextHint.penaltyS : 0;
      if (!penaltyS) return say(ui, 'announce.hint');
      return say({ ...ui, hintTags: { ...ui.hintTags, [u.hintId]: 'paid' } }, 'announce.hintPaid', {
        seconds: penaltyS,
      });
    }
    case 'roles':
      // Said once the new state shows the roles (onState).
      return ui;
    case 'time':
      return say(ui, 'announce.timeChanged', { delta: formatDelta(u.deltaMs) });
    case 'time-up':
      return shout(ui, 'announce.timeUp');
  }
}

export function escapeReducer(ui: EscapeUi, a: EscapeAction): EscapeUi {
  switch (a.type) {
    case 'state':
      return onState(ui, a.state);
    case 'teamUpdate':
      return onTeamUpdate(ui, a.update, a.me);
    case 'finale':
      return { ...ui, finale: a.finale, ended: ui.ended === 'waiting' ? 'final' : ui.ended };
    case 'gameEnded': {
      if (ui.finale) return { ...ui, ended: 'final' };
      // Something was played, so results may still come (or be fetched): wait for them.
      const played = ui.state?.phase === 'running' || ui.state?.phase === 'finale';
      return { ...ui, ended: played ? 'waiting' : 'final' };
    }
    case 'finaleTimeout':
      return ui.ended === 'waiting' ? { ...ui, ended: 'final' } : ui;
    case 'submitAck':
      if (a.ack.ok) return a.ack.outcome === 'wrong' ? say(ui, 'announce.wrong') : ui;
      if (a.ack.reason === 'rate-limited') {
        return say(ui, 'announce.rateLimited', {
          seconds: Math.ceil((a.ack.retryAfterMs ?? 0) / 1000),
        });
      }
      return ui;
    case 'hintAck':
      return !a.ack.ok && a.ack.reason === 'no-hint' ? say(ui, 'announce.hintTaken') : ui;
    case 'clockWarning':
      return shout(ui, 'announce.minutesLeft', { count: a.minutes });
    case 'dismissOverlay':
      return { ...ui, overlay: null };
  }
}
