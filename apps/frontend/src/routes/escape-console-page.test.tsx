import { GameState } from '@quiz-dock/contracts';
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boardOf,
  finaleOf,
  hostStateOf,
  outlineOf,
  SAMPLE_ANSWERS,
} from '../game/escape/host/host-fixtures';
import { type EscapeHostUi, initialEscapeHostUi } from '../game/escape/host/host-reducer';
import { mockApi, renderApp } from '../test/harness';

// The console by phase (M5 Task 5.16), with the real parts: the two hooks are faked.
const { fake } = vi.hoisted(() => ({
  fake: {
    view: {} as Record<string, unknown>,
    ui: {} as unknown,
  },
}));

vi.mock('../game/use-game-session', () => ({
  useGameSession: () => ({
    view: fake.view,
    socket: { emit: vi.fn(), once: vi.fn(), off: vi.fn(), on: vi.fn() },
    attachSeq: 1,
    markJoined: vi.fn(),
  }),
}));

vi.mock('../game/escape/host/use-escape-host', () => ({
  useEscapeHost: () => ({
    active: true,
    ui: fake.ui,
    look: { theme: null, brand: null },
    teams: vi.fn(async () => ({ ok: true })),
    move: vi.fn(async () => ({ ok: true })),
    start: vi.fn(async () => ({ ok: true })),
    pause: vi.fn(async () => ({ ok: true })),
    adjustTime: vi.fn(async () => ({ ok: true })),
    hint: vi.fn(async () => 1),
    unlock: vi.fn(async () => ({ ok: true })),
    end: vi.fn(async () => ({ ok: true })),
    finale: vi.fn(async () => ({ ok: true })),
    runAgain: vi.fn(async () => ({ ok: true })),
    resultsFromRecord: vi.fn(async () => null),
  }),
}));

const PIN = '482913';

function draw(ui: Partial<EscapeHostUi>, view: Record<string, unknown> = {}, path = '') {
  fake.view = {
    status: 'ready',
    state: GameState.Escape,
    connectionLost: false,
    totalQuestions: 0,
    joinBaseUrl: null,
    ...view,
  };
  fake.ui = { ...initialEscapeHostUi, ...ui };
  localStorage.setItem('live.localUser', 'Host');
  mockApi([]);
  return renderApp(`/session/${PIN}/console${path}`);
}

const forming = () => {
  const host = hostStateOf({ board: boardOf({ phase: 'forming' }) });
  return { outline: outlineOf(), host, board: host.board };
};
const running = (over: Partial<ReturnType<typeof boardOf>> = {}) => {
  const base = hostStateOf();
  const host = { ...base, board: { ...base.board, ...over } };
  return { outline: outlineOf(), host, board: host.board };
};

describe('EscapeConsole', () => {
  // The app runs in French in these tests (as the phone's).
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('forming: the invite, the formation, the team board and Start', async () => {
    draw(forming(), { state: GameState.Lobby });
    expect(await screen.findByRole('heading', { name: 'Vault Heist' })).toBeInTheDocument();
    expect(screen.getByText(`PIN ${PIN}`)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Inviter les joueurs' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Équipes' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Équipes de la salle' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Lancer la partie/ })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Commandes de la partie' })).toBeNull();
    expect(screen.queryByRole('timer')).toBeNull();
  });

  it('running: the grid, the feed, the action bar and the run clock', async () => {
    draw(
      running({
        clock: { serverNow: Date.now(), paused: false, elapsedMs: 60_000, limitMs: 2_400_000 },
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Équipes en direct' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Activité' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Commandes de la partie' })).toBeInTheDocument();
    expect(screen.getByRole('timer', { name: 'Temps de jeu' })).toHaveTextContent(
      /^1:0\d sur 40:00$/,
    );
    expect(screen.getByText('En cours')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Inviter les joueurs' })).toBeNull();
  });

  it('running with ?team=: the team detail is open', async () => {
    draw(running(), {}, '?team=t1');
    const detail = await screen
      .findByRole('dialog', { name: 'Team Red' })
      .catch(() => screen.findByRole('complementary', { name: 'Team Red' }));
    expect(within(detail).getByRole('button', { name: 'Donner un indice' })).toBeInTheDocument();
  });

  it('paused: the header says so', async () => {
    draw(
      running({ clock: { serverNow: Date.now(), paused: true, elapsedMs: 0, limitMs: 2_400_000 } }),
    );
    expect(await screen.findByText('En pause')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reprendre' })).toBeInTheDocument();
  });

  it('finale: the results, no run bar', async () => {
    const host = hostStateOf({ board: boardOf({ phase: 'finale' }) });
    draw({ outline: outlineOf(), host, board: host.board, finale: finaleOf() });
    expect(await screen.findByRole('button', { name: 'Télécharger le CSV' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remontrer le final' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Commandes de la partie' })).toBeNull();
  });

  it('the finale phase before its results came: a loading line, not the grid', async () => {
    const host = hostStateOf({ board: boardOf({ phase: 'finale' }) });
    draw({ outline: outlineOf(), host, board: host.board });
    expect(await screen.findByText('Chargement de l’escape game…')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Équipes en direct' })).toBeNull();
  });

  it('closed: the results read-only, from the record alone', async () => {
    draw({ finale: finaleOf(), ended: 'final' }, { status: 'error', state: null });
    expect(await screen.findByRole('button', { name: 'Télécharger le CSV' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remontrer le final' })).toBeNull();
  });

  it("HOST_DISCONNECTED is never the host's own screen: the run stays on", async () => {
    draw(running(), { state: GameState.HostDisconnected });
    expect(await screen.findByRole('heading', { name: 'Équipes en direct' })).toBeInTheDocument();
    expect(screen.queryByText(/animateur déconnecté|host disconnected/i)).toBeNull();
  });

  it('a lost connection disables every action and keeps the view', async () => {
    draw(running(), { connectionLost: true }, '?team=t1');
    expect(await screen.findByRole('heading', { name: 'Équipes en direct' })).toBeInTheDocument();
    const page = document.querySelector<HTMLElement>('[data-escape-phase="running"]')!;
    const buttons = within(page).getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(5);
    for (const b of buttons) expect(b).toBeDisabled();
    // The detail (a sheet outside the page on a tablet) too, all but its close button.
    const detail = screen.queryByRole('dialog', { name: 'Team Red' });
    if (detail) {
      const actions = within(detail)
        .getAllByRole('button')
        .filter((b) => !/fermer|close/i.test(b.getAttribute('aria-label') ?? b.textContent ?? ''));
      for (const b of actions) expect(b).toBeDisabled();
    }
    expect(screen.getAllByRole('button', { name: 'Donner un indice' })[0]).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
  });

  it('a lost connection in the finale keeps "Download CSV" usable, the rest off', async () => {
    const host = hostStateOf({ board: boardOf({ phase: 'finale' }) });
    draw(
      { outline: outlineOf(), host, board: host.board, finale: finaleOf() },
      { connectionLost: true },
    );
    expect(await screen.findByRole('button', { name: 'Télécharger le CSV' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Remontrer le final' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Rejouer|Relancer/ })).toBeDisabled();
  });

  it('a lost connection in the lobby disables Start and the moves', async () => {
    draw(forming(), { state: GameState.Lobby, connectionLost: true });
    expect(await screen.findByRole('button', { name: /Lancer la partie/ })).toBeDisabled();
  });

  it('the big screen panel in every phase, and a way back to the escape rooms', async () => {
    const SOUNDS = { muted: false, musicMuted: false, sfxMuted: false, musicLevel: 1, sfxLevel: 1 };
    const big = () => screen.findByRole('button', { name: /Fenêtre de projection/ });
    const lobby = draw(forming(), { state: GameState.Lobby, sounds: SOUNDS });
    expect(await big()).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Projeter depuis un autre ordinateur' }),
    ).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Audio du salon' })).toBeEnabled();
    lobby.unmount();

    const run = draw(running(), { sounds: SOUNDS });
    expect(await big()).toBeEnabled();
    const page = document.querySelector<HTMLElement>('[data-escape-phase]')!;
    expect(within(page).getByRole('link', { name: 'Escape games' })).toHaveAttribute(
      'href',
      '/escape',
    );
    run.unmount();

    const ended = hostStateOf({ board: boardOf({ phase: 'finale' }) });
    draw({ outline: outlineOf(), host: ended, board: ended.board, finale: finaleOf() });
    expect(await big()).toBeEnabled();
  });

  it('the big screen panel is off while the connection is down', async () => {
    draw(running(), { connectionLost: true, sounds: { muted: false } });
    expect(await screen.findByRole('button', { name: /Fenêtre de projection/ })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Projeter depuis un autre ordinateur' }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Audio du salon' })).toBeDisabled();
  });

  it('a11y, each phase: every control and region is named; the laptop grid has a caption', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query.includes('1024px'),
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );
    const roles = [
      'button',
      'textbox',
      'spinbutton',
      'combobox',
      'link',
      'region',
      'checkbox',
      'radio',
      'switch',
      'menuitem',
      'tab',
    ] as const;
    const named = () => {
      const page = document.querySelector<HTMLElement>('[data-escape-phase]')!;
      for (const role of roles)
        for (const el of within(page).queryAllByRole(role))
          expect(el, el.outerHTML.slice(0, 80)).toHaveAccessibleName();
      // No id twice on the page (labels and aria-* references would point at the wrong one).
      const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
      expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    };
    const lobby = draw(forming(), { state: GameState.Lobby });
    await screen.findByRole('heading', { name: 'Équipes de la salle' });
    named();
    lobby.unmount();
    const run = draw(running(), {}, '?team=t1');
    const table = await screen.findByRole('table', { name: 'Équipes en direct' });
    expect(within(table).getAllByRole('columnheader').length).toBeGreaterThan(2);
    expect(screen.getByRole('complementary', { name: 'Team Red' })).toBeInTheDocument();
    named();
    // A confirm is a labelled dialog.
    fireEvent.click(screen.getByRole('button', { name: 'Terminer la partie' }));
    expect(screen.getByRole('dialog')).toHaveAccessibleName();
    run.unmount();
    const ended = hostStateOf({ board: boardOf({ phase: 'finale' }) });
    draw({ outline: outlineOf(), host: ended, board: ended.board, finale: finaleOf() });
    await screen.findByRole('button', { name: 'Télécharger le CSV' });
    named();
  });

  it('shows no answer of the template in any phase', async () => {
    const lobby = draw(forming(), { state: GameState.Lobby });
    await screen.findByRole('heading', { name: 'Équipes de la salle' });
    const texts = [document.body.textContent!];
    lobby.unmount();
    const run = draw(running(), {}, '?team=t1');
    await screen.findByRole('heading', { name: 'Équipes en direct' });
    texts.push(document.body.textContent!);
    run.unmount();
    const ended = hostStateOf({ board: boardOf({ phase: 'finale' }) });
    draw({ outline: outlineOf(), host: ended, board: ended.board, finale: finaleOf() });
    await screen.findByRole('button', { name: 'Télécharger le CSV' });
    texts.push(document.body.textContent!);
    for (const text of texts)
      for (const a of SAMPLE_ANSWERS) expect(text.toLowerCase()).not.toContain(a);
  });
});
