/**
 * The race port (M8 §1.2): a channel race scheduled on the Site, opened on
 * Live. Live claims it at create (the Site's start, format and brand win),
 * tells the Site the PIN, and reports the top teams after the finale.
 */
import type { LicenceBrand, LicenceHost } from '../licences/licence.port';

export const RACE_PORT = Symbol('RACE_PORT');

export interface SiteRace {
  title: string;
  /** ms epoch. */
  startsAt: number;
  format: 'solo' | 'teams';
  brand: LicenceBrand | null;
}

export type RaceRefusal = 'not-found' | 'not-allowed' | 'not-open' | 'unavailable';

/** The Site's answer to `opened`: `not-open` means another room won the race to open it. */
export type RaceOpened =
  | { ok: true }
  | { ok: false; reason: 'not-found' | 'not-open' | 'unavailable' };

export type RaceClaim = { ok: true; race: SiteRace } | { ok: false; reason: RaceRefusal };

/** One row of a finished race, by place: a team's name, never a player id. */
export interface RaceResultRow {
  place: number;
  name: string;
  escaped: boolean;
  /** The score (run time plus penalties) of an escaped team; null otherwise. */
  timeMs: number | null;
  stages: number;
}

export interface RaceResults {
  /** The room that opened the race: the Site accepts results from it only. */
  pin: string;
  /** ms epoch. */
  endedAt: number;
  totalTeams: number;
  /** At most RACE_RESULTS_TOP rows. */
  top: RaceResultRow[];
}

/** Rows sent to the Site (§1.2). */
export const RACE_RESULTS_TOP = 20;

export interface RacePort {
  claim(host: LicenceHost, siteRaceId: string): Promise<RaceClaim>;
  /**
   * The Site's answer, never thrown; a refusal or failure is logged. The
   * caller closes its room on `not-open` (another room opened the race first).
   */
  opened(siteRaceId: string, pin: string): Promise<RaceOpened>;
  /** Best effort, one retry: a refusal or failure is logged, never thrown. */
  finished(siteRaceId: string, results: RaceResults): Promise<void>;
}
