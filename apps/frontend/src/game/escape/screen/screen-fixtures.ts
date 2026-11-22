import type { EscapeAnnounce, EscapeScreenFinale, EscapeTeamSummary } from '@quiz-dock/contracts';
import { boardOf } from '../host/host-fixtures';
import { GAME } from '../test-fixtures';

/** Builders for the big screen: what the server sends a screen, nothing more. */

export { boardOf, GAME };

export const summaryOf = (over: Partial<EscapeTeamSummary> = {}): EscapeTeamSummary => ({
  id: 't1',
  name: 'Team Red',
  memberCount: 3,
  connectedCount: 3,
  stageIndex: 0,
  stageCount: 3,
  stageTitle: 'The Lobby',
  locksSolved: 0,
  locksTotal: 2,
  hintsUsed: 0,
  escaped: false,
  escapedAtMs: null,
  timedOut: false,
  remainingMs: 2_400_000,
  deadlineAt: 1_002_400_000,
  ...over,
});

export const announceOf = (over: Partial<EscapeAnnounce> = {}): EscapeAnnounce => ({
  kind: 'stage-cleared',
  teamId: 't1',
  teamName: 'Team Red',
  stageIndex: 0,
  ...over,
});

type Ranked = EscapeScreenFinale['ranking'][number];
const ranked = (over: Partial<Ranked> = {}): Ranked => ({
  teamId: 't1',
  name: 'Team Red',
  place: 1,
  scoreMs: 1_932_000,
  escaped: true,
  timedOut: false,
  stagesCleared: 3,
  stageClearedAt: [252_000, 900_000, 1_872_000],
  hintsUsed: 2,
  hintPenaltyS: 60,
  members: ['Ana', 'Ben'],
  ...over,
});

/** The Vault Heist results as a screen gets them: one team escaped, one timed out. */
export const screenFinaleOf = (over: Partial<EscapeScreenFinale> = {}): EscapeScreenFinale => ({
  gameId: GAME,
  title: 'Vault Heist',
  finale: 'The vault is open.',
  limitMs: 2_400_000,
  // Unknown (an older record): the replay falls back on the limit.
  endedMs: null,
  stages: [{ title: 'The Lobby' }, { title: 'The Office' }, { title: 'The Vault' }],
  ranking: [
    ranked(),
    ranked({
      teamId: 't2',
      name: 'Team Blue',
      place: 2,
      scoreMs: null,
      escaped: false,
      timedOut: true,
      stagesCleared: 1,
      stageClearedAt: [300_000],
      hintsUsed: 1,
      hintPenaltyS: 0,
      members: ['Cy', 'Dee'],
    }),
  ],
  awards: { fastest: 't1', fewestHints: 't2', teamwork: null, photoFinish: null },
  ...over,
});
