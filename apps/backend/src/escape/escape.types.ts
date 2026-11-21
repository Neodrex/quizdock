/** Live escape rooms: templates (authored) and run state (per session). */

export type TeamworkMode = 'roles' | 'parallel';
export type Difficulty = 'standard' | 'hard';

export interface Role {
  id: string;
  name: string;
  description: string;
}

/** Text, an image or audio URL, or a document URL. */
export interface Clue {
  id: string;
  /** null: every member sees it. Otherwise only members holding this role. */
  roleId: string | null;
  kind: 'text' | 'image' | 'audio' | 'document';
  body: string;
}

export interface Hint {
  id: string;
  text: string;
  /** Added to the team's time when used. */
  penaltyS: number;
  /** Released by itself this many seconds after the stage opened; null = on request or by the host. */
  releaseAfterS: number | null;
}

interface LockBase {
  id: string;
  label: string;
}
export interface CodeLock extends LockBase {
  kind: 'code';
  answer: string;
}
export interface PhraseLock extends LockBase {
  kind: 'phrase';
  answers: string[];
}
export interface ChoiceLock extends LockBase {
  kind: 'choice';
  options: { id: string; label: string; image: string | null }[];
  correct: string[];
}
export interface SequenceLock extends LockBase {
  kind: 'sequence';
  items: { id: string; label: string }[];
  /** Item ids in the right order. */
  order: string[];
}
/** Roles mode only: each role enters its own part. */
export interface CombinedLock extends LockBase {
  kind: 'combined';
  parts: { roleId: string; answer: string }[];
}
export type Lock = CodeLock | PhraseLock | ChoiceLock | SequenceLock | CombinedLock;

export interface Stage {
  id: string;
  title: string;
  intro: string;
  locks: Lock[];
  clues: Clue[];
  hints: Hint[];
  unlockText: string;
}

export interface EscapeTemplate {
  id: string;
  title: string;
  intro: string;
  difficulty: Difficulty;
  targetMinutes: number;
  mode: TeamworkMode;
  /** Empty in parallel mode. */
  roles: Role[];
  stages: Stage[];
  finale: string;
}

/** A player's answer: text for code/phrase/combined, ids for choice/sequence. */
export type LockInput = string | string[];

export interface TeamState {
  id: string;
  name: string;
  /** Player ids in join order. */
  members: string[];
  /** Role ids held by each connected member (roles mode). */
  roles: Record<string, string[]>;
  stageIndex: number;
  /** Lock ids solved in the current stage. */
  solved: string[];
  /** Combined locks: role ids whose part is entered, per lock id. */
  parts: Record<string, string[]>;
  wrong: number;
  hintsUsed: string[];
  hintPenaltyS: number;
  /**
   * Time the host gave the team, in ms. Positive is in the team's favour: it
   * is subtracted from the ranking score (escapedAt + hint penalties).
   */
  adjustMs: number;
  /** Elapsed ms at which each stage was cleared, by stage index. */
  stageClearedAt: number[];
  escapedAt: number | null;
  /** Lock ids the host opened for the team (shown in results). */
  hostUnlocks: string[];
  /** Correct submissions per player id (the teamwork award). */
  solvesBy: Record<string, number>;
}

export type SubmitResult =
  | { outcome: 'wrong' }
  | { outcome: 'part-accepted'; lockId: string }
  | { outcome: 'lock-solved'; lockId: string }
  | { outcome: 'stage-cleared'; stageIndex: number }
  | { outcome: 'escaped' }
  | {
      outcome: 'refused';
      reason: 'escaped' | 'unknown-lock' | 'already-solved' | 'not-your-part' | 'bad-input';
    };
