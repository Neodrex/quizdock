import { type EscapeHostSession, GameState, toolsOf } from '@quiz-dock/contracts';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boardOf, finaleOf, hostStateOf, outlineOf } from '../game/escape/host/host-fixtures';
import { type EscapeHostUi, initialEscapeHostUi } from '../game/escape/host/host-reducer';
import { ACME_LOOK } from '../game/escape/session/look-fixtures';
import { mockApi, renderApp } from '../test/harness';

// The console follows the session type (M7 Task 7.15): the real parts, the two hooks faked.
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

// The room's look (M7 Task 7.19), from useEscapeHost: unbranded unless a test says otherwise.
const { looks } = vi.hoisted(() => ({ looks: { current: null as unknown } }));

vi.mock('../game/escape/host/use-escape-host', () => ({
  useEscapeHost: () => ({
    active: true,
    ui: fake.ui,
    look: looks.current ?? { theme: null, brand: null },
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

const sessionOf = (over: Partial<EscapeHostSession> = {}): EscapeHostSession => {
  const type = over.type ?? 'hosted';
  return {
    type,
    cap: 6,
    joined: 2,
    race: null,
    licence: null,
    tools: [...toolsOf(type)],
    ...over,
  };
};
const race = (over: Partial<EscapeHostSession> = {}) =>
  sessionOf({
    type: 'race',
    cap: 500,
    joined: 42,
    race: { format: 'teams', startsAt: null, started: false },
    ...over,
  });
const forming = (session: EscapeHostSession) => {
  const host = hostStateOf({ session, board: boardOf({ phase: 'forming' }) });
  return { outline: outlineOf(), host, board: host.board };
};
const running = (session: EscapeHostSession) => {
  const host = hostStateOf({ session });
  return { outline: outlineOf(), host, board: host.board };
};
const finale = (session: EscapeHostSession) => {
  const host = hostStateOf({ session, board: boardOf({ phase: 'finale' }) });
  return { outline: outlineOf(), host, board: host.board, finale: finaleOf() };
};

describe('EscapeConsole by session type', () => {
  // The app runs in French in these tests (as the phone's).
  afterEach(() => {
    vi.useRealTimers();
    looks.current = null;
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('group: no unlock and no CSV; per-team hints and time as the table allows', async () => {
    draw(running(sessionOf({ type: 'group' })), {}, '?team=t1');
    const detail = await screen
      .findByRole('complementary', { name: 'Team Red' })
      .catch(() => screen.findByRole('dialog', { name: 'Team Red' }));
    expect(within(detail).queryByRole('button', { name: /^Ouvrir / })).toBeNull();
    expect(within(detail).getByRole('button', { name: 'Donner un indice' })).toBeInTheDocument();
    expect(within(detail).getByRole('group', { name: 'Temps pour Team Red' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Indice pour tous' })).toBeInTheDocument();
  });

  it('group: the results have no CSV', async () => {
    draw(finale(sessionOf({ type: 'group' })));
    expect(await screen.findByRole('button', { name: 'Remontrer le final' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Télécharger le CSV' })).toBeNull();
  });

  it('group: formation at most 3 teams', async () => {
    draw(forming(sessionOf({ type: 'group' })), { state: GameState.Lobby });
    const count = await screen.findByRole('spinbutton', { name: 'Nombre d’équipes' });
    expect(count).toHaveAttribute('max', '3');
    fireEvent.change(count, { target: { value: '4' } });
    expect(count).toHaveAttribute('aria-invalid', 'true');
  });

  it('race lobby: no formation nor team board; the format, the counts, Start now, the board link', async () => {
    draw(forming(race()), { state: GameState.Lobby, joinBaseUrl: 'https://live.example' });
    expect(await screen.findByRole('heading', { name: 'Course' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Équipes' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Équipes de la salle' })).toBeNull();
    expect(screen.getByText(/Course en équipes/)).toBeInTheDocument();
    expect(screen.getByText('Équipes : 2 · Joueurs : 42')).toBeInTheDocument();
    expect(screen.getByText('Vous lancez cette course.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'https://live.example/race/482913' })).toHaveAttribute(
      'href',
      'https://live.example/race/482913',
    );
    expect(screen.getByRole('button', { name: 'Copier le lien' })).toBeInTheDocument();
  });

  it('race lobby: "Start now" asks first, then starts', async () => {
    draw(forming(race()), { state: GameState.Lobby });
    fireEvent.click(await screen.findByRole('button', { name: 'Démarrer maintenant' }));
    const dialog = screen.getByRole('dialog', { name: 'Démarrer la course maintenant ?' });
    expect(dialog).toHaveTextContent('Les joueurs sans équipe jouent en solo.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Démarrer' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('race lobby: a countdown to the scheduled start, then "Starting…"', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(1_000_000);
    draw(
      forming(race({ race: { format: 'solo', startsAt: 1_000_000 + 299_000, started: false } })),
      {
        state: GameState.Lobby,
      },
    );
    await vi.waitFor(() => expect(screen.getByRole('timer')).toHaveTextContent('Départ dans 4:59'));
    expect(screen.getByText(/Course en solo/)).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(300_000));
    expect(screen.getByRole('timer')).toHaveTextContent('Départ…');
    vi.useRealTimers();
  });

  it('race running: no per-team hint, time or unlock; the board link stays', async () => {
    draw(
      running(race({ race: { format: 'solo', startsAt: null, started: true } })),
      {},
      '?team=t1',
    );
    await screen.findByRole('heading', { name: 'Équipes en direct' });
    expect(screen.queryByRole('button', { name: 'Donner un indice' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Temps pour Team Red' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Ouvrir / })).toBeNull();
    expect(screen.getByRole('button', { name: 'Indice pour tous' })).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'Temps pour toutes les équipes' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /\/race\/482913$/ })).toBeInTheDocument();
  });

  it('the header: the type, the seats, red at the cap, and a hosted licence', async () => {
    draw(
      running(
        sessionOf({
          type: 'hosted',
          cap: 6,
          joined: 6,
          licence: {
            organisationName: 'Acme',
            expiresAt: Date.UTC(2026, 11, 31),
            package: 'bundle',
          },
        }),
      ),
    );
    await screen.findByRole('heading', { name: 'Équipes en direct' });
    expect(screen.getByText('Événement animé')).toBeInTheDocument();
    const seats = screen.getByText('6 / 6 · complet');
    expect(seats).toHaveAccessibleName('Joueurs dans la salle : 6 sur 6');
    expect(seats.className).toMatch(/destructive/);
    expect(screen.getByText(/^Acme · jusqu’au 31/)).toBeInTheDocument();
  });

  it('the header below the cap is not red', async () => {
    draw(running(sessionOf({ type: 'group', cap: 6, joined: 4 })));
    await screen.findByRole('heading', { name: 'Équipes en direct' });
    expect(screen.getByText('Jeu entre amis')).toBeInTheDocument();
    expect(screen.getByText('4 / 6').className).not.toMatch(/destructive/);
  });

  it('at phone width the header and the action bar wrap (no fixed width)', async () => {
    draw(running(sessionOf({ type: 'group' })));
    const bar = await screen.findByRole('region', { name: 'Commandes de la partie' });
    expect(bar.querySelector('.flex-wrap')).not.toBeNull();
    const page = document.querySelector<HTMLElement>('[data-escape-phase]')!;
    expect(page.querySelector('header')!.className).toMatch(/flex-wrap/);
    expect(page.innerHTML).not.toMatch(/\bw-\[\d{3,}px\]|min-w-\[\d{3,}px\]/);
  });

  it('a hosted event: the logo and name in the header, the console under its colours', async () => {
    looks.current = ACME_LOOK;
    draw(running(sessionOf({ type: 'hosted' })));
    await screen.findByRole('heading', { name: 'Équipes en direct' });
    const page = document.querySelector<HTMLElement>('[data-escape-phase]')!;
    const header = page.querySelector('header')!;
    expect(within(header).getByRole('img', { name: 'Logo Acme' })).toBeInTheDocument();
    expect(within(header).getByText('Acme')).toBeInTheDocument();
    expect(
      page.closest<HTMLElement>('[data-theme-scope]')!.style.getPropertyValue('--primary'),
    ).toBe('#c2410c');
  });

  it('no look: no band, the console’s own look', async () => {
    draw(running(sessionOf({ type: 'hosted' })));
    await screen.findByRole('heading', { name: 'Équipes en direct' });
    const page = document.querySelector<HTMLElement>('[data-escape-phase]')!;
    expect(page.querySelector('[data-brand]')).toBeNull();
    expect(page.closest('[data-theme-scope]')).toBeNull();
  });
});
