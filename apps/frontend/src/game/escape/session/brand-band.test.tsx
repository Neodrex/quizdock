import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { drawEn } from '../test-fixtures';
import { BrandBand } from './brand-band';

const acme = {
  name: 'Acme',
  logoUrl: 'https://acme.example/logo.png',
  intro: 'Welcome, Acme team.',
};

describe('BrandBand', () => {
  it('the logo as given, with its alt, and the name', () => {
    drawEn(<BrandBand brand={acme} />);
    const logo = screen.getByRole('img', { name: 'Acme logo' });
    expect(logo).toHaveAttribute('src', acme.logoUrl);
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.queryByText('Welcome, Acme team.')).toBeNull();
  });

  it('a logo that fails to load goes; the name stays', () => {
    drawEn(<BrandBand brand={acme} />);
    fireEvent.error(screen.getByRole('img', { name: 'Acme logo' }));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('Acme')).toBeInTheDocument();
  });

  it('the intro where asked (the screen lobby), and no logo: the name alone', () => {
    drawEn(<BrandBand brand={{ ...acme, logoUrl: null }} intro />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('Welcome, Acme team.')).toBeInTheDocument();
  });

  it('no brand: nothing', () => {
    const { container } = drawEn(<BrandBand brand={null} />);
    expect(container.innerHTML).toBe('');
  });
});
