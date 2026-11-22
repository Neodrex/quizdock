import { GameState } from '@quiz-dock/contracts';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderApp } from '../test/harness';

// The console's escape branch (M5 §1.3). Inactive, the quiz console renders: control-page.test.tsx.

vi.mock('../game/use-game-session', () => ({
  useGameSession: () => ({
    view: { status: 'ready', state: GameState.Lobby, connectionLost: false, totalQuestions: 0 },
    socket: { emit: vi.fn(), once: vi.fn(), off: vi.fn() },
    attachSeq: 1,
    markJoined: vi.fn(),
  }),
}));

vi.mock('../game/escape/host/use-escape-host', () => ({
  useEscapeHost: () => ({ active: true }),
}));

vi.mock('./escape-console-page', () => ({
  EscapeConsole: ({ pin }: { pin: string }) => <h1>escape console {pin}</h1>,
}));

describe('ControlPage: an escape run', () => {
  afterEach(() => localStorage.clear());

  it('hands over to the escape console inside the qd-console wrapper', async () => {
    localStorage.setItem('live.localUser', 'Animateur');
    mockApi([]);
    renderApp('/session/482913/console');
    const heading = await screen.findByRole('heading', { name: 'escape console 482913' });
    expect(heading.closest('.qd-console')).not.toBeNull();
  });
});
