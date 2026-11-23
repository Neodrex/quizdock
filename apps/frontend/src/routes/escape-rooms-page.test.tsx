import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureAnonymousParticipants } from '../config';
import { mockApi, renderApp } from '../test/harness';
import { refusalError } from '../game/game-client';
import type { EscapeTemplateListItemDto } from '../api/generated/model';
import { openIfLaunchable } from './escape-rooms-page';

const { createEscapeRoom } = vi.hoisted(() => ({
  createEscapeRoom: vi.fn<(id: string, o?: unknown) => Promise<{ pin: string }>>(),
}));
vi.mock('../game/escape/host/host-client', async (orig) => ({
  ...(await orig<typeof import('../game/escape/host/host-client')>()),
  createEscapeRoom: (id: string, o?: unknown) => createEscapeRoom(id, o),
}));
// The console the create leads to: not under test here.
vi.mock('./control-page', () => ({ ControlPage: () => <h1>console</h1> }));

const item = {
  id: 'e1',
  title: 'Vault Heist',
  status: 'published',
  version: 1,
  updatedAt: '2026-11-22T10:00:00.000Z',
  mode: 'roles',
  difficulty: 'standard',
  targetMinutes: 40,
  stageCount: 4,
};
const draft = {
  ...item,
  id: 'e2',
  title: 'Lost Library',
  status: 'draft',
  version: 0,
  mode: 'parallel',
  difficulty: 'hard',
  targetMinutes: 30,
  stageCount: 3,
};
// A stored row the schema no longer reads: no picker fields.
const broken = {
  ...item,
  id: 'e3',
  title: 'Broken',
  mode: null,
  difficulty: null,
  targetMinutes: null,
  stageCount: null,
};

const devLicence = {
  id: 'dev',
  organisationName: null,
  package: 'annual',
  participantCap: 500,
  expiresAt: Date.UTC(2027, 0, 1),
  eventsLeft: null,
  hasBrand: false,
};
const library = { ...draft, id: 'e4', status: 'published', version: 1 };

function signedIn() {
  localStorage.setItem('live.localUser', 'Animateur');
}
const card = (title: string) => screen.getByRole('article', { name: title });

describe('/escape', () => {
  afterEach(() => {
    localStorage.clear();
    configureAnonymousParticipants(false);
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends a signed-out visitor to the sign-in page', async () => {
    mockApi([]);
    renderApp('/escape');
    expect(await screen.findByLabelText('Votre nom')).toBeInTheDocument();
  });

  it('is in the nav as "Escape rooms", marked as the current page', async () => {
    signedIn();
    mockApi([{ path: '/escape-templates', body: [] }]);
    renderApp('/escape');
    await screen.findByRole('heading', { level: 1 });
    const links = screen.getAllByRole('link', { name: 'Escape games' });
    expect(links[0]).toHaveAttribute('aria-current', 'page');
  });

  it('lists each template: title, mode, difficulty, length, stages and status', async () => {
    signedIn();
    mockApi([{ path: '/escape-templates', body: [item, draft] }]);
    renderApp('/escape');
    await screen.findByRole('article', { name: 'Vault Heist' });
    const vault = within(card('Vault Heist'));
    expect(vault.getByText('Rôles et cadenas combinés')).toBeInTheDocument();
    expect(vault.getByText('Normal')).toBeInTheDocument();
    expect(vault.getByText('40 min')).toBeInTheDocument();
    expect(vault.getByText('Étapes : 4')).toBeInTheDocument();
    expect(vault.getByText('Publié')).toBeInTheDocument();
    const library = within(card('Lost Library'));
    expect(library.getByText('Cadenas en parallèle')).toBeInTheDocument();
    expect(library.getByText('Difficile')).toBeInTheDocument();
    expect(library.getByText('Brouillon')).toBeInTheDocument();
  });

  it('shows the length read-only: no duration field', async () => {
    signedIn();
    mockApi([{ path: '/escape-templates', body: [item] }]);
    renderApp('/escape');
    await screen.findByRole('article', { name: 'Vault Heist' });
    expect(
      within(card('Vault Heist')).getByText(
        'Dure 40 min. Vous pourrez ajouter du temps pendant la partie.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('empty: adds the sample rooms (list items only), then the list shows them', async () => {
    signedIn();
    let added = false;
    const api = mockApi([
      { path: '/escape-templates', body: [] },
      { method: 'POST', path: /\/escape-templates\/samples\?view=summary$/, body: [draft] },
    ]);
    renderApp('/escape');
    const add = await screen.findByRole('button', { name: 'Ajouter les salles d’exemple' });
    // The refreshed list.
    api.mockImplementation(async (_url: string, opts?: RequestInit) => {
      if ((opts?.method ?? 'GET') === 'POST') {
        added = true;
        return Response.json([draft], { status: 201 });
      }
      return Response.json(added ? [draft] : []);
    });
    fireEvent.click(add);
    expect(await screen.findByRole('article', { name: 'Lost Library' })).toBeInTheDocument();
    expect(api.mock.calls.some(([url]) => String(url).endsWith('/samples?view=summary'))).toBe(
      true,
    );
  });

  it('a draft is greyed out and cannot be launched; Publish (summary) refreshes the list', async () => {
    signedIn();
    let published = false;
    const api = vi.fn(async (url: string, opts?: RequestInit) => {
      if ((opts?.method ?? 'GET') === 'POST' && url.endsWith('/e2/publish?view=summary')) {
        published = true;
        return Response.json({ ...draft, status: 'published', version: 1 });
      }
      return Response.json(published ? [{ ...draft, status: 'published' }] : [draft]);
    });
    vi.stubGlobal('fetch', api);
    renderApp('/escape');
    await screen.findByRole('article', { name: 'Lost Library' });
    const library = within(card('Lost Library'));
    expect(library.getByText('Publiez-le d’abord')).toBeInTheDocument();
    expect(library.getByRole('button', { name: 'Créer la salle' })).toBeDisabled();
    // aria-disabled is inherited: on the card it would announce Publish as disabled too.
    const publish = library.getByRole('button', { name: 'Publier' });
    expect(publish).toBeEnabled();
    expect(publish.closest('[aria-disabled="true"]')).toBeNull();
    fireEvent.click(publish);
    await waitFor(() =>
      expect(
        within(card('Lost Library')).getByRole('button', { name: 'Créer la salle' }),
      ).toBeEnabled(),
    );
    expect(createEscapeRoom).not.toHaveBeenCalled();
  });

  it('a refused publish says why', async () => {
    signedIn();
    mockApi([
      { path: '/escape-templates', body: [draft] },
      {
        method: 'POST',
        path: /\/e2\/publish\?view=summary$/,
        status: 400,
        body: { code: 'escape_template.invalid', problems: ['x'] },
      },
    ]);
    renderApp('/escape');
    await screen.findByRole('article', { name: 'Lost Library' });
    fireEvent.click(within(card('Lost Library')).getByRole('button', { name: 'Publier' }));
    expect(await within(card('Lost Library')).findByRole('alert')).toHaveTextContent(
      'Ce modèle de jeu d’évasion n’est pas valide.',
    );
  });

  it('a row without a mode (unreadable) is greyed out, with no Create nor Publish', async () => {
    signedIn();
    mockApi([{ path: '/escape-templates', body: [broken] }]);
    renderApp('/escape');
    await screen.findByRole('article', { name: 'Broken' });
    const row = within(card('Broken'));
    expect(card('Broken')).not.toHaveAttribute('aria-disabled');
    expect(
      row.getByText('Cette salle est illisible : impossible de l’ouvrir.'),
    ).toBeInTheDocument();
    expect(row.getByRole('button', { name: 'Créer la salle' })).toBeDisabled();
    expect(row.queryByRole('button', { name: 'Publier' })).toBeNull();
  });

  it('Create emits once on a double click, then opens the console', async () => {
    signedIn();
    let open: (v: { pin: string }) => void = () => {};
    createEscapeRoom.mockImplementation(() => new Promise((r) => (open = r)));
    mockApi([
      { path: '/escape-templates', body: [item] },
      { path: '/escape-licences', body: [devLicence] },
    ]);
    const { router } = renderApp('/escape');
    await screen.findByRole('article', { name: 'Vault Heist' });
    const create = within(card('Vault Heist')).getByRole('button', { name: 'Créer la salle' });
    fireEvent.click(create);
    fireEvent.click(create);
    // The session dialog comes first: a roles template is a hosted event.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: /Événement animé/ })).toBeChecked();
    await within(dialog).findByRole('combobox', { name: 'Licence' });
    const go = within(dialog).getByRole('button', { name: 'Créer' });
    fireEvent.click(go);
    fireEvent.click(go);
    expect(createEscapeRoom).toHaveBeenCalledTimes(1);
    expect(createEscapeRoom).toHaveBeenCalledWith('e1', {
      sessionType: 'hosted',
      licenceId: 'dev',
    });
    open({ pin: '482913' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/session/482913/console'));
  });

  it('under OIDC with open access offered, asks how players get in first', async () => {
    configureAnonymousParticipants(true);
    createEscapeRoom.mockResolvedValue({ pin: '482913' });
    mockApi([
      { path: '/escape-templates', body: [item] },
      { path: '/me/preferences', body: {} },
      { path: '/escape-licences', body: [devLicence] },
      {
        path: '/me',
        body: { id: 'u1', displayName: 'Hôte', email: null, roles: ['host'], subject: 'kc' },
      },
    ]);
    const { router } = renderApp('/escape', 'oidc', true);
    await screen.findByRole('article', { name: 'Vault Heist' });
    fireEvent.click(within(card('Vault Heist')).getByRole('button', { name: 'Créer la salle' }));
    fireEvent.click(await screen.findByRole('radio', { name: /Accès libre/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Lancer' }));
    // Then the session type.
    const dialog = await screen.findByRole('dialog', { name: /Comment jouer Vault Heist/ });
    await within(dialog).findByRole('combobox', { name: 'Licence' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Créer' }));
    await waitFor(() =>
      expect(createEscapeRoom).toHaveBeenCalledWith('e1', {
        participantAccess: 'open',
        sessionType: 'hosted',
        licenceId: 'dev',
      }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/session/482913/console'));
  });

  it('a refused create shows its text', async () => {
    signedIn();
    createEscapeRoom.mockRejectedValue(
      Object.assign(new Error('Ce modèle de jeu d’évasion n’est pas valide.'), {
        code: 'escape_template.invalid',
      }),
    );
    mockApi([
      { path: '/escape-templates', body: [item] },
      { path: '/escape-licences', body: [devLicence] },
    ]);
    renderApp('/escape');
    await screen.findByRole('article', { name: 'Vault Heist' });
    fireEvent.click(within(card('Vault Heist')).getByRole('button', { name: 'Créer la salle' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('combobox', { name: 'Licence' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Créer' }));
    // The refusal stays in the dialog, which can try again or be closed.
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Ce modèle de jeu d’évasion n’est pas valide.',
    );
    expect(within(dialog).getByRole('button', { name: 'Créer' })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Annuler' }));
    await waitFor(() =>
      expect(
        within(card('Vault Heist')).getByRole('button', { name: 'Créer la salle' }),
      ).toBeEnabled(),
    );
  });

  it('group play goes to the host’s own phone join', async () => {
    signedIn();
    createEscapeRoom.mockResolvedValue({ pin: '482913' });
    mockApi([
      { path: '/escape-templates', body: [library] },
      { path: '/escape-licences', body: [] },
    ]);
    const { router } = renderApp('/escape');
    await screen.findByRole('article', { name: 'Lost Library' });
    fireEvent.click(within(card('Lost Library')).getByRole('button', { name: 'Créer la salle' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: /Jeu entre amis/ })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Créer' }));
    await waitFor(() =>
      expect(createEscapeRoom).toHaveBeenCalledWith('e4', { sessionType: 'group' }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/join/482913'));
    // The server knows the phone host (`isPhoneHost`): no query needed.
    expect(router.state.location.searchStr).toBe('');
  });

  // ── M8 Task 8.17: opened from a Site race's link ──

  it('a Site race link: the page says so, the dialog preselects it, and the create claims it', async () => {
    signedIn();
    createEscapeRoom.mockResolvedValue({ pin: '482913' });
    mockApi([
      { path: '/escape-templates', body: [library] },
      { path: '/escape-licences', body: [] },
    ]);
    const { router } = renderApp('/escape?siteRace=r1&title=Friday&startsAt=1900000000000');
    expect(
      await screen.findByText(/Ouverture de la course du Site « Friday »/),
    ).toBeInTheDocument();
    await screen.findByRole('article', { name: 'Lost Library' });
    fireEvent.click(within(card('Lost Library')).getByRole('button', { name: 'Créer la salle' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Course du Site : Friday')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Créer' }));
    await waitFor(() =>
      expect(createEscapeRoom).toHaveBeenCalledWith('e4', {
        sessionType: 'race',
        race: { format: 'solo', siteRaceId: 'r1' },
      }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/session/482913/console'));
  });

  it.each(['1e20', 'null'])(
    'a Site race link with startsAt=%s: the start is set by the Site; a long title is cut at 200',
    async (startsAt) => {
      signedIn();
      mockApi([
        { path: '/escape-templates', body: [library] },
        { path: '/escape-licences', body: [] },
      ]);
      renderApp(`/escape?siteRace=r1&startsAt=${startsAt}&title=${'y'.repeat(300)}`);
      await screen.findByRole('article', { name: 'Lost Library' });
      fireEvent.click(within(card('Lost Library')).getByRole('button', { name: 'Créer la salle' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Heure de départ fixée par le Site')).toBeInTheDocument();
      expect(within(dialog).getByText(`Course du Site : ${'y'.repeat(200)}`)).toBeInTheDocument();
    },
  );

  it('a refused Site race (escape.race_not_open) shows its text in the dialog', async () => {
    signedIn();
    createEscapeRoom.mockRejectedValue(refusalError({ code: 'escape.race_not_open' }));
    mockApi([
      { path: '/escape-templates', body: [library] },
      { path: '/escape-licences', body: [] },
    ]);
    renderApp('/escape?siteRace=r1');
    await screen.findByRole('article', { name: 'Lost Library' });
    fireEvent.click(within(card('Lost Library')).getByRole('button', { name: 'Créer la salle' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Heure de départ fixée par le Site')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Créer' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Cette course ne peut pas être ouverte maintenant',
    );
  });

  it('a race goes to the console', async () => {
    signedIn();
    createEscapeRoom.mockResolvedValue({ pin: '482913' });
    mockApi([
      { path: '/escape-templates', body: [library] },
      { path: '/escape-licences', body: [] },
    ]);
    const { router } = renderApp('/escape');
    await screen.findByRole('article', { name: 'Lost Library' });
    fireEvent.click(within(card('Lost Library')).getByRole('button', { name: 'Créer la salle' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: /Course/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Créer' }));
    await waitFor(() =>
      expect(createEscapeRoom).toHaveBeenCalledWith('e4', {
        sessionType: 'race',
        race: { format: 'solo' },
      }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/session/482913/console'));
  });

  it('buttons are tap-sized (laptop and tablet)', async () => {
    signedIn();
    mockApi([{ path: '/escape-templates', body: [item, draft] }]);
    renderApp('/escape');
    await screen.findByRole('article', { name: 'Vault Heist' });
    for (const b of screen.getAllByRole('button', { name: /Créer la salle|Publier/ })) {
      expect(b.className).toMatch(/min-h-1[12]/);
    }
  });

  it('Create on a template that cannot be launched opens nothing', () => {
    const open = vi.fn(() => Promise.resolve());
    for (const r of [draft, broken]) openIfLaunchable(r as EscapeTemplateListItemDto, open)();
    expect(open).not.toHaveBeenCalled();
    openIfLaunchable(item as EscapeTemplateListItemDto, open)();
    expect(open).toHaveBeenCalledExactlyOnceWith('e1');
  });
});
