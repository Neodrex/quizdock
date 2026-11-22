import { GameState } from '@quiz-dock/contracts';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../test/harness';

// The projection's escape branch (M6 §1.3). Inactive, the quiz screen renders: screen-page.test.tsx.

vi.mock('../game/use-game-session', () => ({
  useGameSession: () => ({
    view: {
      status: 'ready',
      state: GameState.Lobby,
      connectionLost: true,
      totalQuestions: 0,
      language: null,
    },
    socket: { emit: vi.fn(), once: vi.fn(), off: vi.fn(), on: vi.fn() },
    pairingCode: '4821',
    attachSeq: 1,
    markJoined: vi.fn(),
  }),
}));

vi.mock('../game/escape/screen/use-escape-screen', () => ({
  useEscapeScreen: () => ({ active: true }),
}));

vi.mock('./escape-screen-page', () => ({
  EscapeScreen: ({ pin }: { pin: string }) => <h1>escape screen {pin}</h1>,
}));

describe('ScreenPage: an escape run', () => {
  it('hands over to the escape screen, keeping the lost-connection banner and the pairing code', async () => {
    renderApp('/session/482913/projection');
    expect(await screen.findByRole('heading', { name: 'escape screen 482913' })).toBeVisible();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText('4821')).toBeInTheDocument();
  });
});
