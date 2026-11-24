/**
 * Live escape runs over Socket.IO (M3). Inbound payloads are zod schemas the
 * escape gateway parses; outbound payloads are plain interfaces. Phones only
 * ever get EscapePlayerState, EscapeTeamUpdate and EscapeFinale. Answers never
 * leave the server: the host console's EscapeHostOutline has none either (M5).
 */
import { z } from 'zod';
import type { EscapeTemplateContent } from './escape';
import type { ThemeValues } from './theme';

const pin = z.string().regex(/^\d{6}$/); // allocatePin: 6 digits
const id = z.string().min(1).max(64);
const lockInput = z.union([z.string().max(200), z.array(id).max(12)]);
const durationMin = z.number().int().min(5).max(180);

// ── Session types (M7 §1.1) ──

/** Group play (public), race (channel), hosted event (corporate, licensed). */
export const ESCAPE_SESSION_TYPES = ['group', 'race', 'hosted'] as const;
export type EscapeSessionType = (typeof ESCAPE_SESSION_TYPES)[number];

/** A host action the session type may allow. */
export const ESCAPE_TOOLS = [
  'teams',
  'move',
  'start',
  'pause',
  'adjust-all',
  'adjust-team',
  'hint-team',
  'hint-all',
  'unlock',
  'end',
  'finale',
  'csv',
] as const;
export type EscapeTool = (typeof ESCAPE_TOOLS)[number];

const SESSION_TOOLS: Record<EscapeSessionType, readonly EscapeTool[]> = {
  group: [
    'teams',
    'move',
    'start',
    'pause',
    'adjust-all',
    'adjust-team',
    'hint-team',
    'hint-all',
    'end',
    'finale',
  ],
  race: ['start', 'pause', 'adjust-all', 'hint-all', 'end', 'finale', 'csv'],
  hosted: ESCAPE_TOOLS,
};

/** The host tools a session type allows: the console and the engine read the same table. */
export function toolsOf(type: EscapeSessionType): readonly EscapeTool[] {
  return SESSION_TOOLS[type];
}

// ── Host → server ──
export const escapeCreateSchema = z
  .object({
    templateId: id,
    durationMin: durationMin.optional(),
    pickOwnName: z.boolean().optional(),
    personalTracking: z.boolean().optional(),
    participantAccess: z.enum(['account', 'open']).optional(),
    /** Absent: a hosted event (a legacy create). */
    sessionType: z.enum(ESCAPE_SESSION_TYPES).optional(),
    /** Hosted only; absent: the host's only usable licence. */
    licenceId: id.optional(),
    /** Required for a race, refused otherwise. `startsAt` (ms epoch) is checked against server time. */
    race: z
      .object({
        format: z.enum(['solo', 'teams']),
        startsAt: z.number().int().positive().optional(),
        /**
         * M8: the Site race this room opens. The server claims it and takes the
         * Site's start and format over the ones sent here.
         */
        siteRaceId: id.optional(),
      })
      .optional(),
  })
  .refine((d) => (d.sessionType === 'race') === (d.race !== undefined), {
    message: 'race data goes with a race, and only with one',
    path: ['race'],
  })
  .refine(
    (d) => d.licenceId === undefined || d.sessionType === undefined || d.sessionType === 'hosted',
    { message: 'a licence goes with a hosted event only', path: ['licenceId'] },
  );
export const escapeOpenSchema = z.object({
  pin,
  templateId: id,
  durationMin: durationMin.optional(),
  /** Used only when the room has no session yet (a quiz room): it becomes hosted. */
  licenceId: id.optional(),
});
/** escape:sync, escape:start, escape:end, escape:finale. */
export const escapePinSchema = z.object({ pin });
export const escapeTeamsSchema = z.object({
  pin,
  mode: z.enum(['auto', 'self']),
  count: z.number().int().min(1).max(100),
  maxSize: z.number().int().min(1).max(50).optional(),
  names: z.array(z.string().trim().min(1).max(40)).max(100).optional(),
});
/** `teamId: null` sends the player back to the unassigned list. */
export const escapeMoveSchema = z.object({ pin, playerId: id, teamId: id.nullable() });
export const escapePauseSchema = z.object({ pin, paused: z.boolean() });
/** Absent `teamId`: every team. Extra time moves deadlines only, never scores. */
export const escapeAdjustTimeSchema = z.object({
  pin,
  deltaS: z
    .number()
    .int()
    .min(-3600)
    .max(3600)
    .refine((v) => v !== 0),
  teamId: id.optional(),
});
/**
 * Absent `teamId`: every team. `hintId`, for one team only: the hint the host
 * confirmed; refused (`escape.hint-changed`) when it is not the team's next one.
 */
export const escapeHintSchema = z
  .object({ pin, teamId: id.optional(), hintId: id.optional() })
  .refine((v) => v.hintId === undefined || v.teamId !== undefined);
export const escapeUnlockSchema = z.object({ pin, teamId: id, lockId: id });

// ── Player → server ──
export const escapeChooseTeamSchema = z.object({ pin, teamId: id });
/** Team race (M7 §1.7): starts a team and gives its code. */
export const escapeNewTeamSchema = z.object({ pin, name: z.string().trim().min(1).max(40) });
/** Team race: joins a team by its code (any case, spaces allowed). */
export const escapeJoinTeamSchema = z.object({ pin, code: z.string().max(16) });
export const escapeSubmitSchema = z.object({
  pin,
  lockId: id,
  roleId: id.optional(),
  input: lockInput,
});
/** The hint the phone was offered (`nextHint.id`): a double tap releases one hint, not two. */
export const escapeAskHintSchema = z.object({ pin, hintId: id });
/**
 * A finished run's results (`EscapeFinale.gameId`), readable after the room ended,
 * by whoever was in the room: a socket of that room (phone, screen, host console),
 * or a phone back with the session token it joined with.
 */
export const escapeResultsSchema = z.object({
  gameId: z.string().regex(/^[0-9a-f]{32}$/),
  sessionToken: z.string().min(1).max(200).optional(),
});

export type EscapeCreate = z.infer<typeof escapeCreateSchema>;
export type EscapeOpen = z.infer<typeof escapeOpenSchema>;
export type EscapePin = z.infer<typeof escapePinSchema>;
export type EscapeTeams = z.infer<typeof escapeTeamsSchema>;
export type EscapeMove = z.infer<typeof escapeMoveSchema>;
export type EscapePause = z.infer<typeof escapePauseSchema>;
export type EscapeAdjustTime = z.infer<typeof escapeAdjustTimeSchema>;
export type EscapeHint = z.infer<typeof escapeHintSchema>;
export type EscapeUnlock = z.infer<typeof escapeUnlockSchema>;
export type EscapeChooseTeam = z.infer<typeof escapeChooseTeamSchema>;
export type EscapeNewTeam = z.infer<typeof escapeNewTeamSchema>;
export type EscapeJoinTeam = z.infer<typeof escapeJoinTeamSchema>;
export type EscapeSubmit = z.infer<typeof escapeSubmitSchema>;
export type EscapeAskHint = z.infer<typeof escapeAskHintSchema>;
export type EscapeResults = z.infer<typeof escapeResultsSchema>;

// ── Server → client ──

/** Mirrors the backend's PlayerLockView (escape-rules.ts); a compile-time check proves it. */
export interface EscapePlayerLockView {
  id: string;
  label: string;
  kind: 'code' | 'phrase' | 'choice' | 'sequence' | 'combined';
  solved: boolean;
  options?: { id: string; label: string; image: string | null }[];
  /** Sequence items in a stable per-team hash order. */
  items?: { id: string; label: string }[];
  /** Combined: every role with a part (role names are public), the ones this player may enter, and which are in. */
  partRoles?: string[];
  myParts?: string[];
  partsDone?: string[];
  /** Code: the answer is digits only, so the phone may show a number pad. */
  digits?: true;
}

/** Mirrors the backend's PlayerView: everything one phone may know of its stage. */
export interface EscapePlayerView {
  stageIndex: number;
  stageCount: number;
  title: string;
  intro: string;
  roles: string[];
  clues: {
    id: string;
    roleId: string | null;
    kind: 'text' | 'image' | 'audio' | 'document';
    body: string;
  }[];
  locks: EscapePlayerLockView[];
  hints: { id: string; text: string }[];
  escaped: boolean;
}

export type EscapePhase = 'forming' | 'running' | 'finale';

export interface EscapeClock {
  /** Server epoch ms when this was built. */
  serverNow: number;
  paused: boolean;
  /** Run time so far, pauses excluded. */
  elapsedMs: number;
  limitMs: number;
}

export interface EscapeTeamClock {
  remainingMs: number;
  /** Server epoch ms of the team's deadline; null when paused, ended, escaped or timed out. */
  deadlineAt: number | null;
}

export interface EscapeMember {
  playerId: string;
  nickname: string;
  avatar: string | null;
  connected: boolean;
  roles: string[];
}

export interface EscapeFormation {
  mode: 'auto' | 'self';
  /** null: no cap. */
  maxSize: number | null;
  teams: { id: string; name: string; memberCount: number }[];
}

/** The room's session as a phone sees it (M7 §1.4). */
export interface EscapePlayerSession {
  type: EscapeSessionType;
  /** A race's format; null for the other types. */
  raceFormat: 'solo' | 'teams' | null;
  /** A scheduled race's start (server epoch ms); null otherwise. */
  startsAt: number | null;
  /** Group play: this phone is also the session's host (owner question 1). */
  isPhoneHost: boolean;
}

/** To one phone. */
export interface EscapePlayerState {
  /** The run's id: the key for escape:results, and how a phone sees a new game in its room. */
  gameId: string;
  /** null: a room opened before session types. */
  session: EscapePlayerSession | null;
  phase: EscapePhase;
  clock: EscapeClock;
  title: string;
  intro: string;
  roles: { id: string; name: string; description: string }[];
  formation: EscapeFormation;
  team:
    | (EscapeTeamClock & {
        id: string;
        name: string;
        members: EscapeMember[];
        stageIndex: number;
        stageCount: number;
        escaped: boolean;
        /** Run time (ms) at the team's escape, without hint penalties; null until it escapes. */
        escapedMs: number | null;
        timedOut: boolean;
        hintPenaltyS: number;
        /** A team race: this team's code, for friends to join (never another team's). */
        code?: string;
      })
    | null;
  /** playerView(tpl, team, me) while running; null before the start or without a team. */
  view: EscapePlayerView | null;
  /** The next hint's id and cost, never its text. */
  nextHint: { id: string; penaltyS: number } | null;
}

/** One team on the big screen: counts and titles, no secrets. */
export interface EscapeTeamSummary {
  id: string;
  name: string;
  memberCount: number;
  connectedCount: number;
  stageIndex: number;
  stageCount: number;
  stageTitle: string;
  locksSolved: number;
  locksTotal: number;
  hintsUsed: number;
  escaped: boolean;
  /** Run time (ms) at the team's escape, pauses excluded, no extra time or penalties; null until then. */
  escapedAtMs: number | null;
  timedOut: boolean;
  remainingMs: number;
  deadlineAt: number | null;
}

/** A player on the lobby screen: nickname only (M6 owner answer 1). */
export interface EscapeRosterEntry {
  /** null: no team yet. */
  teamId: string | null;
  nickname: string;
  connected: boolean;
}

/** The room's session on the board (M7 §1.4): public, as the board is. */
export interface EscapeBoardSession {
  type: EscapeSessionType;
  /** A scheduled race's start (server epoch ms): the lobby counts down to it. */
  startsAt: number | null;
  /** The whole room, also when `teams` holds only a race's top teams. */
  totals: { teams: number; players: number; escaped: number };
}

/** A hosted event's brand as every client shows it (M7 §1.9): no licence details. */
export interface EscapeBrand {
  /** The organisation as shown ("Acme Ltd"). */
  name: string;
  /** An https image (null: the name alone). */
  logoUrl: string | null;
  /** Plain text, at most 280 characters, for the screen lobby. */
  intro: string | null;
}

/** escape:look: the room's colours and brand, static per room. null/null: unbranded. */
export interface EscapeLook {
  theme: ThemeValues | null;
  brand: EscapeBrand | null;
}

export interface EscapeBoard {
  /** The run's id: what the screen keys its record by. */
  gameId: string;
  /** null: a room opened before session types. */
  session: EscapeBoardSession | null;
  phase: EscapePhase;
  clock: EscapeClock;
  title: string;
  /** How teams form: auto (dealt) or self (picked on the phone), and the cap (null: none). */
  formation: Pick<EscapeFormation, 'mode' | 'maxSize'>;
  /** Every team in team order; in a race, the top teams by place only (M7 §1.7). */
  teams: EscapeTeamSummary[];
  /** Players in the room without a team. */
  unassigned: number;
  /** While forming, every player in join order; [] once running (keeps the board small). */
  roster: EscapeRosterEntry[];
}

/** To the team's phones and the host. `by` is the player id, or null when the host did it. */
export type EscapeTeamUpdate = { teamId: string } & (
  | { kind: 'wrong'; by: string }
  | { kind: 'part-accepted'; lockId: string; roleId: string; by: string }
  | { kind: 'lock-solved'; lockId: string; by: string | null }
  | { kind: 'stage-cleared'; stageIndex: number; unlockText: string; by: string | null }
  | { kind: 'escaped'; unlockText: string; by: string | null }
  | { kind: 'hint'; hintId: string; source: 'request' | 'timer' | 'host' }
  | { kind: 'roles' }
  | { kind: 'time'; deltaMs: number }
  | { kind: 'time-up' }
);

/** Screen banners. */
export interface EscapeAnnounce {
  kind: 'stage-cleared' | 'escaped' | 'hint' | 'time-up';
  teamId: string;
  teamName: string;
  stageIndex: number;
}

export interface EscapeHostTeam extends EscapeTeamSummary {
  members: EscapeMember[];
  /** Lock ids solved in the current stage. */
  solved: string[];
  /** Combined locks: role ids entered, per lock id. */
  partsDone: Record<string, string[]>;
  wrong: number;
  /** Every hint released to the team, in order. */
  hintIds: string[];
  /** The ones of `hintIds` that cost their penalty (asked or given by the host); timed hints are free. */
  paidHintIds: string[];
  hintPenaltyS: number;
  /** Extra time the host gave (deadline only). */
  adjustMs: number;
  hostUnlocks: string[];
  solvesBy: Record<string, number>;
  stageClearedAt: number[];
  lastProgressAt: number;
  stuck: boolean;
  timeOnStageMs: number;
}

/**
 * The room's session as the host console sees it (M7 §1.4): the type, its cap,
 * seats taken and tools. Of the licence, only what the host may read: never its
 * id, its uses left or who may use it.
 */
export interface EscapeHostSession {
  type: EscapeSessionType;
  cap: number;
  /** Seats taken: every player record of the room (owner question 3). */
  joined: number;
  race: { format: 'solo' | 'teams'; startsAt: number | null; started: boolean } | null;
  licence: {
    /** The brand's name; null for a licence without a brand. */
    organisationName: string | null;
    expiresAt: number;
    package: 'single' | 'bundle' | 'annual';
  } | null;
  tools: EscapeTool[];
}

export interface EscapeHostState {
  /** The run's id: the key for escape:results, and how the console sees a new run. */
  gameId: string;
  /** null: a room opened before session types (treated as hosted). */
  session: EscapeHostSession | null;
  board: EscapeBoard;
  formation: EscapeFormation;
  teams: EscapeHostTeam[];
  unassigned: { playerId: string; nickname: string; connected: boolean }[];
  templateVersion: number;
}

/**
 * In a race (M9 Task 9.3) or a hosted event (Batch 2 fix round), what the host
 * room would otherwise get one frame at a time, sent once per held period (a
 * race's board period; a hosted event's host period, or at once after a host
 * command): the team updates in order, then each changed team's detail as of
 * the send.
 */
export interface EscapeHostBatch {
  /** Oldest first, as `escape:team-update` gives them in group play. */
  updates: EscapeTeamUpdate[];
  /** Each changed team once; empty when an `escape:host` (every team) follows. */
  teams: EscapeHostTeam[];
}

type EscapeStageContent = EscapeTemplateContent['stages'][number];

/**
 * A lock as the host console sees it: what it is, never what opens it. Choice
 * options and sequence items are labels only, items in a per-run hash order
 * (never template order, which may be the solution); a combined lock lists the
 * role of each part.
 */
export interface EscapeHostLock {
  id: string;
  label: string;
  kind: EscapeStageContent['locks'][number]['kind'];
  partRoles?: string[];
  options?: { id: string; label: string; image: string | null }[];
  items?: { id: string; label: string }[];
}

export interface EscapeHostStage {
  id: string;
  title: string;
  intro: string;
  unlockText: string;
  locks: EscapeHostLock[];
  clues: EscapeStageContent['clues'];
  /** Every hint, released or not: the host decides whether to give the next one. */
  hints: EscapeStageContent['hints'];
}

/** The frozen template without its answers: host console only (M5 owner question 1). */
export interface EscapeHostOutline {
  templateId: string;
  version: number;
  title: string;
  intro: string;
  mode: EscapeTemplateContent['mode'];
  difficulty: EscapeTemplateContent['difficulty'];
  targetMinutes: number;
  roles: EscapeTemplateContent['roles'];
  stages: EscapeHostStage[];
}

export interface EscapeFinale {
  /** The run's game id: the key `escape:results` reads them back by. */
  gameId: string;
  /**
   * A race's phone (M7 §1.7): `ranking` holds the top teams plus the phone's own,
   * and this counts them all. Absent: `ranking` is whole.
   */
  totalTeams?: number;
  title: string;
  finale: string;
  ranking: {
    teamId: string;
    name: string;
    place: number;
    /** Escape time plus paid hint penalties; null when the team did not escape. */
    scoreMs: number | null;
    escaped: boolean;
    stagesCleared: number;
    stageClearedAt: number[];
    /** Every hint, free (timed) or paid. */
    hintsUsed: number;
    /** Hints the team paid for: the fewest-hints award. */
    paidHints: number;
    hintPenaltyS: number;
    adjustMs: number;
    hostUnlocks: number;
    members: string[];
  }[];
  awards: {
    fastest: string | null;
    fewestHints: string | null;
    teamwork: string | null;
    photoFinish: [string, string] | null;
  };
}

/**
 * The finale for a screen (M6 §1.4): every socket of the room that is not a
 * phone or the host console. No host column (extra time, host unlocks, paid
 * hints) and no player id; members by nickname (owner answer 1). The stage
 * titles, the run limit and `timedOut` are for the split-time replay.
 */
export interface EscapeScreenFinale {
  gameId: string;
  /** A race: `ranking` holds the top teams only, and this counts them all. */
  totalTeams?: number;
  title: string;
  /** The template's closing text. */
  finale: string;
  limitMs: number;
  /**
   * Run time (ms, pauses excluded) at which the run ended: the last escape, the latest
   * deadline a team hit, or the host's end. Null when not known (an older record).
   */
  endedMs: number | null;
  /** Every stage title: the run is over. */
  stages: { title: string }[];
  ranking: {
    teamId: string;
    name: string;
    place: number;
    scoreMs: number | null;
    escaped: boolean;
    timedOut: boolean;
    stagesCleared: number;
    /** Run time (ms) at each stage clear, pauses excluded, no penalties. */
    stageClearedAt: number[];
    hintsUsed: number;
    hintPenaltyS: number;
    /** Nicknames only. */
    members: string[];
  }[];
  awards: EscapeFinale['awards'];
}

/** Rules refusals (M1) plus the live ones. */
export type EscapeRefusal =
  | 'escaped'
  | 'not-a-member'
  | 'unknown-lock'
  | 'already-solved'
  | 'not-your-part'
  | 'bad-input'
  | 'not-running'
  | 'paused'
  | 'no-team'
  | 'time-up'
  | 'rate-limited'
  | 'not-joined'
  | 'no-hint';

export type EscapeSubmitAck =
  | { ok: true; outcome: 'wrong' | 'part-accepted' | 'lock-solved' | 'stage-cleared' | 'escaped' }
  | { ok: false; reason: EscapeRefusal; retryAfterMs?: number };

export type EscapeAskHintAck = { ok: true } | { ok: false; reason: EscapeRefusal };

/** Host and formation commands: ok, or the exception filter's error code. */
export type EscapeAck<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: { code: string } };

export interface EscapeClientToServerEvents {
  /** Host: creates an empty room and opens the run on it. */
  'escape:create': (p: EscapeCreate, ack: (res: { pin: string }) => void) => void;
  /** Host: opens a run in its room while it is in LOBBY. */
  'escape:open': (p: EscapeOpen, ack: (res: EscapeAck) => void) => void;
  /** Anyone in the room: joins its escape rooms and gets its view (host, phone or screen). */
  'escape:sync': (p: EscapePin, ack: (res: EscapeAck) => void) => void;
  /** Host, while forming: makes the teams. */
  'escape:teams': (p: EscapeTeams, ack: (res: EscapeAck) => void) => void;
  /** Host: moves a player to a team, or to unassigned. */
  'escape:move': (p: EscapeMove, ack: (res: EscapeAck) => void) => void;
  /** Host: starts the clock. */
  'escape:start': (p: EscapePin, ack: (res: EscapeAck) => void) => void;
  /** Host: pauses or resumes the run. */
  'escape:pause': (p: EscapePause, ack: (res: EscapeAck) => void) => void;
  /** Host: gives or takes time, for one team or all (deadline only). */
  'escape:adjust-time': (p: EscapeAdjustTime, ack: (res: EscapeAck) => void) => void;
  /** Host: releases the next hint to one team or all; `released` counts teams that got one. */
  'escape:hint': (p: EscapeHint, ack: (res: EscapeAck<{ released: number }>) => void) => void;
  /** Host: opens a lock for a team. */
  'escape:unlock': (p: EscapeUnlock, ack: (res: EscapeAck) => void) => void;
  /** Host: ends the run. */
  'escape:end': (p: EscapePin, ack: (res: EscapeAck) => void) => void;
  /** Host: shows the finale to the whole room. */
  'escape:finale': (p: EscapePin, ack: (res: EscapeAck) => void) => void;
  /** Player, in self formation: joins a team. */
  'escape:choose-team': (p: EscapeChooseTeam, ack: (res: EscapeAck) => void) => void;
  /**
   * Player, in a team race: starts a team (forming, or running without one).
   * Refusals: `escape.not_in_session`, `escape.wrong_phase`.
   */
  'escape:new-team': (
    p: EscapeNewTeam,
    ack: (res: EscapeAck<{ teamId: string; code: string }>) => void,
  ) => void;
  /**
   * Player, in a team race: joins a team by code. Refusals: `escape.team_code_unknown`,
   * `escape.team_full`, `escape.too_many_codes` (5 wrong codes a minute), and as new-team.
   */
  'escape:join-team': (
    p: EscapeJoinTeam,
    ack: (res: EscapeAck<{ teamId: string }>) => void,
  ) => void;
  /**
   * M8: player, in a team race while forming: leaves its team and races solo
   * (a team left empty is gone with its code). Refusals: `escape.not_in_session`
   * (not a team race), `escape.wrong_phase` (the race has started).
   */
  'escape:leave-team': (p: EscapePin, ack: (res: EscapeAck) => void) => void;
  /** Player: tries a lock. */
  'escape:submit': (p: EscapeSubmit, ack: (res: EscapeSubmitAck) => void) => void;
  /** Player: asks for the hint it was offered. */
  'escape:ask-hint': (p: EscapeAskHint, ack: (res: EscapeAskHintAck) => void) => void;
  /** Anyone who was in the room: a finished run's stored finale, the room ended or not. */
  'escape:results': (
    p: EscapeResults,
    ack: (res: EscapeAck<{ finale: EscapeFinale }>) => void,
  ) => void;
}

export interface EscapeServerToClientEvents {
  /** To one phone. */
  'escape:state': (p: EscapePlayerState) => void;
  /** To the team room and (in group play) the host room. */
  'escape:team-update': (p: EscapeTeamUpdate) => void;
  /**
   * To the board room and the host room, throttled (a hosted event's console
   * gets it with its own held sends, or inside `escape:host`).
   */
  'escape:board': (p: EscapeBoard) => void;
  /** To the board room and (in group play) the host room. */
  'escape:announce': (p: EscapeAnnounce) => void;
  /** To the host room, on sync and structural changes (held in races and hosted events). */
  'escape:host': (p: EscapeHostState) => void;
  /** To the host room, when one team changed (group play). */
  'escape:host-team': (p: EscapeHostTeam) => void;
  /** To the host room in a race or a hosted event, at most once per held period. */
  'escape:host-batch': (p: EscapeHostBatch) => void;
  /** To the host room only, on sync: the run's template, without its answers. */
  'escape:outline': (p: EscapeHostOutline) => void;
  /** To the phones and the host console of the PIN room. */
  'escape:finale': (p: EscapeFinale) => void;
  /** To every other socket of the PIN room (screens, copies), and to a screen's sync in the finale. */
  'escape:screen-finale': (p: EscapeScreenFinale) => void;
  /** To every synced socket (console, phone, screen, follow copy), once per sync. */
  'escape:look': (p: EscapeLook) => void;
}
