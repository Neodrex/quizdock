import type {
  EscapeBoard,
  EscapeHostOutline,
  EscapeHostState,
  EscapeHostTeam,
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

const en = i18n.cloneInstance({ lng: 'en' });

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

// ── Host console (M5) ──

/**
 * The Vault Heist sample as the host console gets it (`hostOutlineOf`): no answers.
 * Sequence items in a run's hash order, never the solution's.
 */
export const outlineOf = (over: Partial<EscapeHostOutline> = {}): EscapeHostOutline => ({
  templateId: 'tpl-vh',
  version: 1,
  title: 'Vault Heist',
  intro: 'Get in, get out.',
  mode: 'roles',
  difficulty: 'standard',
  targetMinutes: 40,
  roles: [
    { id: 'hacker', name: 'Hacker', description: 'Reads screens, notes and passwords.' },
    { id: 'safecracker', name: 'Safecracker', description: 'Reads dials, locks and metal.' },
    { id: 'lookout', name: 'Lookout', description: 'Watches the guards and the street.' },
  ],
  stages: [
    {
      id: 'lobby',
      title: 'The Lobby',
      intro: 'A marble lobby.',
      unlockText: 'The staff door clicks open.',
      locks: [
        { id: 'lobby-door', label: 'Staff door keypad', kind: 'code' },
        {
          id: 'lobby-badge',
          label: 'Which badge gets you past the guard?',
          kind: 'choice',
          options: [
            { id: 'red', label: 'Red badge', image: null },
            { id: 'blue', label: 'Blue badge', image: null },
          ],
        },
      ],
      clues: [
        { id: 'lobby-plaque', roleId: null, kind: 'text', body: 'A brass plaque.' },
        { id: 'lobby-guard', roleId: 'lookout', kind: 'text', body: 'The guard wears blue.' },
      ],
      hints: [
        { id: 'lobby-h1', text: 'Look at the plaque.', penaltyS: 30, releaseAfterS: null },
        { id: 'lobby-h2', text: 'The year is the code.', penaltyS: 60, releaseAfterS: 600 },
      ],
    },
    {
      id: 'security',
      title: 'The Security Room',
      intro: 'Screens everywhere.',
      unlockText: 'The cameras go dark.',
      locks: [
        {
          id: 'security-switch',
          label: 'Camera master switch',
          kind: 'combined',
          partRoles: ['hacker', 'safecracker', 'lookout'],
        },
        { id: 'security-override', label: 'Alarm override phrase', kind: 'phrase' },
      ],
      clues: [],
      hints: [
        { id: 'security-h1', text: 'Each of you has a word.', penaltyS: 30, releaseAfterS: null },
      ],
    },
    {
      id: 'vault-door',
      title: 'The Vault Door',
      intro: 'Three dials.',
      unlockText: 'You are out.',
      locks: [
        {
          id: 'vault-dials',
          label: 'Turn the medal dials in order',
          kind: 'sequence',
          items: [
            { id: 'bronze', label: 'Bronze dial' },
            { id: 'silver', label: 'Silver dial' },
            { id: 'gold', label: 'Gold dial' },
          ],
        },
      ],
      clues: [],
      hints: [],
    },
  ],
  ...over,
});

export const hostTeamOf = (over: Partial<EscapeHostTeam> = {}): EscapeHostTeam => ({
  id: 't1',
  name: 'Team Red',
  memberCount: 2,
  connectedCount: 2,
  stageIndex: 0,
  stageCount: 3,
  stageTitle: 'The Lobby',
  locksSolved: 0,
  locksTotal: 2,
  hintsUsed: 0,
  escaped: false,
  timedOut: false,
  remainingMs: 2_400_000,
  deadlineAt: 1_002_400_000,
  members: [
    {
      playerId: 'p1',
      nickname: 'Ana',
      avatar: null,
      connected: true,
      roles: ['hacker', 'lookout'],
    },
    { playerId: 'p2', nickname: 'Ben', avatar: null, connected: true, roles: ['safecracker'] },
  ],
  solved: [],
  partsDone: {},
  wrong: 0,
  hintIds: [],
  hintPenaltyS: 0,
  adjustMs: 0,
  hostUnlocks: [],
  solvesBy: {},
  stageClearedAt: [],
  lastProgressAt: 0,
  stuck: false,
  timeOnStageMs: 0,
  ...over,
});

export const boardOf = (over: Partial<EscapeBoard> = {}): EscapeBoard => ({
  phase: 'running',
  clock: { serverNow: 1_000_000_000, paused: false, elapsedMs: 0, limitMs: 2_400_000 },
  title: 'Vault Heist',
  teams: [],
  unassigned: 0,
  ...over,
});

export const hostStateOf = (over: Partial<EscapeHostState> = {}): EscapeHostState => {
  const teams = over.teams ?? [
    hostTeamOf(),
    hostTeamOf({ id: 't2', name: 'Team Blue', members: [], memberCount: 0, connectedCount: 0 }),
  ];
  return {
    gameId: GAME,
    board: boardOf({ teams }),
    formation: { mode: 'auto', maxSize: null, teams: [] },
    teams,
    unassigned: [],
    templateVersion: 1,
    ...over,
  };
};
