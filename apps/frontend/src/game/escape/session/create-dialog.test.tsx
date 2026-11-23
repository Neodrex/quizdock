import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '../../../test/harness';
import { en } from '../test-fixtures';
import { CreateSessionDialog, type SessionChoice } from './create-dialog';

const DEC_31 = Date.UTC(2026, 11, 31, 12);
const acme = {
  id: 'acme',
  organisationName: 'Acme',
  package: 'bundle',
  participantCap: 8,
  expiresAt: DEC_31,
  eventsLeft: 2,
  hasBrand: true,
};
const dev = {
  ...acme,
  id: 'dev',
  organisationName: null,
  package: 'annual',
  participantCap: 500,
  eventsLeft: null,
  hasBrand: false,
};

function draw(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={en}>{ui}</I18nextProvider>
    </QueryClientProvider>,
  );
}

const parallel = { title: 'Lost Library', mode: 'parallel' as const };
const roles = { title: 'Vault Heist', mode: 'roles' as const };

function dialog(
  template: { title: string; mode: 'roles' | 'parallel' } = parallel,
  onCreate = vi.fn<(c: SessionChoice) => Promise<void>>().mockResolvedValue(),
) {
  draw(<CreateSessionDialog open template={template} onCreate={onCreate} onCancel={vi.fn()} />);
  return onCreate;
}
const create = () => screen.getByRole('button', { name: 'Create' });

describe('CreateSessionDialog', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers three types, each with its line', () => {
    mockApi([{ path: '/escape-licences', body: [] }]);
    dialog();
    expect(screen.getByRole('radio', { name: /Group play/ })).toBeChecked();
    expect(screen.getByText('Up to 6 players, one phone runs it')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Race/ })).toBeEnabled();
    expect(screen.getByText('Up to 500, starts on its own, public board')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Hosted event/ })).toBeEnabled();
    expect(screen.getByText('Your licence, your brand, every tool')).toBeInTheDocument();
  });

  it('group play creates with its type alone', async () => {
    mockApi([{ path: '/escape-licences', body: [] }]);
    const onCreate = dialog();
    fireEvent.click(create());
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ sessionType: 'group' }));
  });

  it('a roles template is hosted only, and says why', async () => {
    mockApi([{ path: '/escape-licences', body: [acme] }]);
    dialog(roles);
    expect(screen.getByRole('radio', { name: /Group play/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Race/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Hosted event/ })).toBeChecked();
    expect(screen.getByText('This room needs roles: hosted events only')).toBeInTheDocument();
  });

  it('hosted: one licence, shown in full and preselected', async () => {
    mockApi([{ path: '/escape-licences', body: [acme] }]);
    const onCreate = dialog(roles);
    const select = await screen.findByRole('combobox', { name: 'Licence' });
    expect(select).toHaveDisplayValue(/^Acme · 8 players · 2 events left · until /);
    expect(select).toHaveDisplayValue(/Dec/);
    fireEvent.click(create());
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({ sessionType: 'hosted', licenceId: 'acme' }),
    );
  });

  it('hosted: several licences wait for a pick', async () => {
    mockApi([{ path: '/escape-licences', body: [acme, dev] }]);
    const onCreate = dialog(roles);
    const select = await screen.findByRole('combobox', { name: 'Licence' });
    expect(screen.getByRole('option', { name: /Unnamed licence · 500 players · annual/ }));
    expect(create()).toBeDisabled();
    fireEvent.change(select, { target: { value: 'dev' } });
    fireEvent.click(create());
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({ sessionType: 'hosted', licenceId: 'dev' }),
    );
  });

  it('hosted with no licence: says so, and Create stays off', async () => {
    mockApi([{ path: '/escape-licences', body: [] }]);
    dialog(roles);
    expect(await screen.findByText('No licence available')).toBeInTheDocument();
    expect(create()).toBeDisabled();
  });

  const HINT =
    'No licence yet. Site admins can run races without one; to host a licensed event, a Site admin adds you as a facilitator at /admin/licences.';

  const me = (roles: string[]) => ({
    path: '/me',
    body: { id: 'u1', displayName: 'Dev', email: null, roles },
  });

  it.each([
    ['an admin', ['host', 'admin']],
    ['a host', ['host']],
  ])('hosted with no licence, for %s: says how to get one from the Site', async (_who, mine) => {
    mockApi([{ path: '/escape-licences', body: [] }, me(mine)]);
    dialog(roles);
    expect(await screen.findByText('No licence available')).toBeInTheDocument();
    expect(screen.getByText(HINT)).toBeInTheDocument();
  });

  it('a host with licences gets the picker, not the hint', async () => {
    mockApi([{ path: '/escape-licences', body: [acme] }]);
    dialog(roles);
    expect(await screen.findByRole('combobox', { name: 'Licence' })).toBeInTheDocument();
    expect(screen.queryByText(HINT)).toBeNull();
  });

  // ── Opened from a Site race (M8 Task 8.17) ──

  const fromSite = (
    siteRace: { id: string; title?: string; startsAt?: number },
    template: { title: string; mode: 'roles' | 'parallel' } = parallel,
    onCreate = vi.fn<(c: SessionChoice) => Promise<void>>().mockResolvedValue(),
  ) => {
    mockApi([{ path: '/escape-licences', body: [] }]);
    draw(
      <CreateSessionDialog
        open
        template={template}
        siteRace={siteRace}
        onCreate={onCreate}
        onCancel={vi.fn()}
      />,
    );
    return onCreate;
  };

  it('a Site race preselects Race and shows its title and start; no format or start to pick', () => {
    fromSite({ id: 'r1', title: 'Friday race', startsAt: DEC_31 });
    expect(screen.getByRole('radio', { name: /Race/ })).toBeChecked();
    expect(screen.getByText('Site race: Friday race')).toBeInTheDocument();
    const when = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(DEC_31),
    );
    expect(screen.getByText(`Starts ${when}`)).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Race format' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Start' })).toBeNull();
  });

  it('the payload carries the Site race id, not the shown start', async () => {
    const onCreate = fromSite({ id: 'r1', title: 'Friday race', startsAt: DEC_31 });
    fireEvent.click(create());
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        sessionType: 'race',
        race: { format: 'solo', siteRaceId: 'r1' },
      }),
    );
  });

  it('without startsAt the start is set by the Site; without a title it still says Site race', () => {
    fromSite({ id: 'r1' });
    expect(screen.getByText('Site race')).toBeInTheDocument();
    expect(screen.getByText('Start time set by the Site')).toBeInTheDocument();
  });

  it('a start no date can hold shows as set by the Site, and a long title is cut at 200', () => {
    fromSite({ id: 'r1', title: 'x'.repeat(300), startsAt: 1e20 });
    expect(screen.getByText('Start time set by the Site')).toBeInTheDocument();
    expect(screen.getByText(`Site race: ${'x'.repeat(200)}`)).toBeInTheDocument();
  });

  it('a refused Site race shows its text', async () => {
    const onCreate = vi.fn<(c: SessionChoice) => Promise<void>>().mockRejectedValue(
      Object.assign(new Error(en.t('errors:escape.race_not_open')), {
        code: 'escape.race_not_open',
      }),
    );
    fromSite({ id: 'r1', title: 'Friday race' }, parallel, onCreate);
    fireEvent.click(create());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This race cannot be opened now: it is not in its opening window, or another room already opened it.',
    );
  });

  it('another type chosen drops the Site race from the payload', async () => {
    const onCreate = fromSite({ id: 'r1', title: 'Friday race' });
    fireEvent.click(screen.getByRole('radio', { name: /Group play/ }));
    fireEvent.click(create());
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ sessionType: 'group' }));
  });
});
