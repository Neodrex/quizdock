import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { mockApi, renderApp } from '../test/harness';

describe('/escape', () => {
  afterEach(() => localStorage.clear());

  it('sends a signed-out visitor to the sign-in page', async () => {
    mockApi([]);
    renderApp('/escape');
    expect(await screen.findByLabelText('Votre nom')).toBeInTheDocument();
  });

  it('is in the nav as "Escape rooms", marked as the current page', async () => {
    localStorage.setItem('live.localUser', 'Animateur');
    mockApi([]);
    renderApp('/escape');
    await screen.findByRole('heading', { level: 1 });
    const links = screen.getAllByRole('link', { name: 'Escape games' });
    expect(links[0]).toHaveAttribute('aria-current', 'page');
  });
});
