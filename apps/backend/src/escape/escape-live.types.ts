/** Live escape run records, stored in Redis under the game id (M3 plan §1.4). */

import type { EscapeTemplate, TeamState } from './escape.types';

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
  phase: 'forming' | 'running' | 'finished' | 'finale';
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
}
