/** Live escape run records, stored in Redis under the game id (M3 plan §1.4). */

import type { EscapeSessionType } from '@quiz-dock/contracts';
import type { EscapeTemplate, TeamState } from './escape.types';
import type { Licence, LicenceBrand } from './licences/licence.port';

/** The template frozen at open, answers included: server side only. */
export interface EscapeSnapshot {
  templateId: string;
  version: number;
  template: EscapeTemplate;
  takenAt: number;
}

export interface RunClock {
  /** Epoch ms of the start; 0 while forming. */
  startedAt: number;
  /** Epoch ms of the current pause; 0 when running. */
  pausedAt: number;
  /** Paused time so far (closed pauses only). */
  pausedMs: number;
  /** Run time at which the run ended; null until then. */
  endedElapsedMs: number | null;
  limitMs: number;
}

export interface EscapeRun {
  phase: 'forming' | 'running' | 'finale';
  formation: 'auto' | 'self';
  /** 0 = no cap. */
  maxSize: number;
  /** Display order. */
  teamIds: string[];
  clock: RunClock;
}

export interface TeamRecord {
  team: TeamState;
  /** Run ms of the last accepted part, solve or unlock. */
  lastProgressAt: number;
  stuck: boolean;
  timedOut: boolean;
  /** A team race: the code friends join it by (M7 §1.7). */
  code?: string;
}

/** A licence as a hosted room keeps it from its create: a change on the Site never alters it. */
export interface FrozenLicence {
  id: string;
  organisationId: string;
  participantCap: number;
  expiresAt: number;
  package: Licence['package'];
  brand: LicenceBrand | null;
}

/** The room's session (M7 §1.4), kept per room: every run opened in it inherits it. */
export interface EscapeSession {
  type: EscapeSessionType;
  /** Written to room:<pin>:cap too. */
  cap: number;
  race: { format: 'solo' | 'teams'; startsAt: number | null; started: boolean } | null;
  /** Hosted only. */
  licence: FrozenLicence | null;
  /** Owner question 4: the licence is used at the room's first start. */
  licenceUsed: boolean;
  /** Group play: the creator, who also plays (owner question 1). */
  phoneHostUserId: string | null;
}
