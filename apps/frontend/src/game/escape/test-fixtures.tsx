import type {
  EscapePlayerLockView,
  EscapePlayerState,
  EscapePlayerView,
} from '@quiz-dock/contracts';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../i18n';

/** Builders for the phone's escape components: what the server sends, nothing more. */

export const GAME = '0123456789abcdef0123456789abcdef';
export const ME = 'p-me';

export const en = i18n.cloneInstance({ lng: 'en' });

export const drawEn = (ui: ReactNode) => render(<I18nextProvider i18n={en}>{ui}</I18nextProvider>);

export type Team = NonNullable<EscapePlayerState['team']>;

export const lock = (over: Partial<EscapePlayerLockView> = {}): EscapePlayerLockView => ({
  id: 'pad',
  label: 'Keypad',
  kind: 'code',
  solved: false,
  ...over,
});

export const view = (over: Partial<EscapePlayerView> = {}): EscapePlayerView => ({
  stageIndex: 1,
  stageCount: 4,
  title: 'The vault door',
  intro: 'Find the code.',
  roles: ['lookout'],
  clues: [],
  locks: [lock()],
  hints: [],
  escaped: false,
  ...over,
});

export const team = (over: Partial<Team> = {}): Team => ({
  id: 't1',
  name: 'Red Foxes',
  members: [
    { playerId: ME, nickname: 'Ana', avatar: null, connected: true, roles: ['lookout'] },
    { playerId: 'p2', nickname: 'Ben', avatar: null, connected: false, roles: ['safe'] },
  ],
  stageIndex: 1,
  stageCount: 4,
  escaped: false,
  escapedMs: null,
  timedOut: false,
  hintPenaltyS: 0,
  remainingMs: 600_000,
  deadlineAt: 1_000_600_000,
  ...over,
});

export const state = (over: Partial<EscapePlayerState> = {}): EscapePlayerState => ({
  gameId: GAME,
  phase: 'running',
  clock: { serverNow: 1_000_000_000, paused: false, elapsedMs: 0, limitMs: 3_600_000 },
  title: 'Vault Heist',
  intro: 'Get in, get out.',
  roles: [
    { id: 'lookout', name: 'Lookout', description: 'Watches the guards.' },
    { id: 'safe', name: 'Safecracker', description: 'Opens the safe.' },
  ],
  formation: { mode: 'auto', maxSize: 4, teams: [] },
  team: team(),
  view: view(),
  nextHint: null,
  ...over,
});
