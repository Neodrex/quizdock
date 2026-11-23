/**
 * Session types (M7 §1.1): every rule a type sets, as data. Pure: the engine
 * reads it at a few guard points. The host tools themselves are the contracts'
 * `toolsOf`, shared with the console; caps and payload limits stay here.
 */
import { type EscapeSessionType, type EscapeTool, toolsOf } from '@quiz-dock/contracts';
import type { EscapeTemplate } from './escape.types';

export const GROUP_MAX_PLAYERS = 6;
export const RACE_MAX_PLAYERS = 500;
/** Teams of a race shown on the board, by place; the rest are counted in the totals. */
export const RACE_BOARD_TEAMS = 30;
/** At most one board (and host state) a second in a race. */
export const RACE_BOARD_EVERY_MS = 1000;
/** Teams in a phone's or the screen's race finale, plus the phone's own. */
export const RACE_FINALE_TOP = 20;
/** A scheduled race starts at most this far ahead (the room lives 4 h). */
export const RACE_MAX_LEAD_MIN = 180;
/** Slack on both bounds of a race's lead, for the trip from the dialog to the server. */
export const RACE_LEAD_SLACK_MS = 5_000;

type TeamworkMode = EscapeTemplate['mode'];

/** Payload trimming for a large session. */
export interface SessionLimits {
  boardTeams: number;
  boardEveryMs: number;
  finaleTop: number;
}

export interface SessionRules {
  /** Participant cap; `licence`: the frozen licence's. */
  cap: number | 'licence';
  modes: readonly TeamworkMode[];
  licence: boolean;
  /** null: no bound beyond the formation schema's. */
  formation: { maxTeams: number | null; maxSize: number | null };
  limits: SessionLimits | null;
}

export const SESSION_RULES: Record<EscapeSessionType, SessionRules> = {
  group: {
    cap: GROUP_MAX_PLAYERS,
    modes: ['parallel'],
    licence: false,
    formation: { maxTeams: 3, maxSize: GROUP_MAX_PLAYERS },
    limits: null,
  },
  race: {
    cap: RACE_MAX_PLAYERS,
    modes: ['parallel'],
    licence: false,
    formation: { maxTeams: null, maxSize: 3 },
    limits: {
      boardTeams: RACE_BOARD_TEAMS,
      boardEveryMs: RACE_BOARD_EVERY_MS,
      finaleTop: RACE_FINALE_TOP,
    },
  },
  hosted: {
    cap: 'licence',
    modes: ['parallel', 'roles'],
    licence: true,
    formation: { maxTeams: null, maxSize: null },
    limits: null,
  },
};

/** The room's participant cap. A hosted event takes its licence's. */
export function capOf(type: EscapeSessionType, licence?: { participantCap: number }): number {
  const cap = SESSION_RULES[type].cap;
  if (cap !== 'licence') return cap;
  if (!licence) throw new Error(`a ${type} session needs its licence for a cap`);
  return licence.participantCap;
}

/** Whether a template of this teamwork mode may run in this session type. */
export function modeAllowed(type: EscapeSessionType, mode: TeamworkMode): boolean {
  return SESSION_RULES[type].modes.includes(mode);
}

export function toolAllowed(type: EscapeSessionType, tool: EscapeTool): boolean {
  return toolsOf(type).includes(tool);
}

export function limitsOf(type: EscapeSessionType): SessionLimits | null {
  return SESSION_RULES[type].limits;
}
