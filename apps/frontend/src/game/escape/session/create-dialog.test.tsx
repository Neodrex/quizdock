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

  it('hosted: the licence list did not load: says so with a retry, not "No licence"', async () => {
    mockApi([{ path: '/escape-licences', status: 500, body: { message: 'boom' } }]);
    dialog(roles);
    expect(await screen.findByText('The room could not be opened. Try again.')).toBeInTheDocument();
    expect(screen.queryByText('No licence available')).toBeNull();
    expect(create()).toBeDisabled();
    mockApi([{ path: '/escape-licences', body: [acme] }]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('combobox', { name: 'Licence' })).toBeInTheDocument();
    expect(create()).toBeEnabled();
  });

  it('race: solo or teams, started by the host', async () => {
    mockApi([{ path: '/escape-licences', body: [] }]);
    const onCreate = dialog();
    fireEvent.click(screen.getByRole('radio', { name: /Race/ }));
    expect(screen.getByRole('radio', { name: /Solo/ })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: /Teams/ }));
    expect(screen.getByRole('radio', { name: /I’ll start it/ })).toBeChecked();
    fireEvent.click(create());
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({ sessionType: 'race', race: { format: 'teams' } }),
    );
  });

  it('race: a start time between 1 and 180 minutes ahead', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    mockApi([{ path: '/escape-licences', body: [] }]);
    const onCreate = dialog();
    fireEvent.click(screen.getByRole('radio', { name: /Race/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Starts on its own/ }));
    const minutes = screen.getByRole('spinbutton', { name: 'Starts in (minutes)' });
    for (const bad of ['0', '181', '2.5', '']) {
      fireEvent.change(minutes, { target: { value: bad } });
      expect(create()).toBeDisabled();
      expect(minutes).toHaveAttribute('aria-invalid', 'true');
    }
    fireEvent.change(minutes, { target: { value: '90' } });
    expect(create()).toBeEnabled();
    fireEvent.click(create());
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        sessionType: 'race',
        race: { format: 'solo', startsAt: 1_000_000 + 90 * 60_000 },
      }),
    );
    vi.useRealTimers();
  });

  it('a refusal shows its text in the dialog', async () => {
    mockApi([{ path: '/escape-licences', body: [acme] }]);
    const onCreate = vi
      .fn<(c: SessionChoice) => Promise<void>>()
      .mockRejectedValue(
        Object.assign(new Error('This licence has expired.'), { code: 'escape.licence_expired' }),
      );
    dialog(roles, onCreate);
    await screen.findByRole('combobox', { name: 'Licence' });
    fireEvent.click(create());
    expect(await screen.findByRole('alert')).toHaveTextContent('This licence has expired.');
    expect(create()).toBeEnabled();
  });
});
