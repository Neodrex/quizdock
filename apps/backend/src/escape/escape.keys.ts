import { GAME_TTL_S, type GameId } from '../game/game.keys';

/** Escape keys live as long as the room's game keys (SPECIFICATIONS-DONNEES §4). */
export const ESCAPE_TTL_S = GAME_TTL_S;

/** Redis keys of an escape run, under its game id (see gameKeys). */
export const escapeKeys = {
  /** The frozen template, answers included, server side only: JSON EscapeSnapshot. */
  template: (id: GameId) => `game:${id}:escape:template`,
  /** Phase, formation and clock: JSON EscapeRun. */
  run: (id: GameId) => `game:${id}:escape:run`,
  /** Hash teamId → JSON TeamRecord { team: TeamState, lastProgressAt, stuck, timedOut }. */
  teams: (id: GameId) => `game:${id}:escape:teams`,
  /** Hash playerId → teamId: the lookup behind every submit. */
  members: (id: GameId) => `game:${id}:escape:members`,
  /** A team's wrong answers in the current window (SET NX EX + INCR, as pin-attempts). */
  wrong: (id: GameId, teamId: string) => `game:${id}:escape:wrong:${teamId}`,
  /** The PIN of the room the run was played in: who may read its results after the end. */
  room: (id: GameId) => `game:${id}:escape:room`,
  /** The user id of the run's host: who may read its results once the room is gone (M5). */
  host: (id: GameId) => `game:${id}:escape:host`,
  /** Final ranking and awards (JSON EscapeFinale), kept for M5's export. */
  results: (id: GameId) => `game:${id}:escape:results`,
};

/** Redis keys of an escape room, under its PIN: what every run in it shares. */
export const escapeRoomKeys = {
  /** The room's session type, cap and frozen licence: JSON EscapeSession. */
  session: (pin: string) => `escape:session:${pin}`,
};

/** Socket.IO rooms (not Redis): who receives what. */
export const escapeRooms = {
  host: (pin: string) => `${pin}:escape:host`,
  board: (pin: string) => `${pin}:escape:board`,
  team: (id: GameId, teamId: string) => `escape:${id}:team:${teamId}`,
};
