import type { EscapeFinale } from '@quiz-dock/contracts';
import { screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import { EscapeFinaleView } from './escape-finale';
import { drawEn, GAME } from './test-fixtures';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

const row = (over: Partial<EscapeFinale['ranking'][number]>): EscapeFinale['ranking'][number] => ({
  teamId: 't1',
  name: 'Red Foxes',
  place: 1,
  scoreMs: 1_500_000,
  escaped: true,
  stagesCleared: 4,
  stageClearedAt: [],
  hintsUsed: 3,
  paidHints: 2,
  hintPenaltyS: 120,
  adjustMs: 0,
  hostUnlocks: 0,
  members: ['Ana', 'Ben'],
  ...over,
});

const finale: EscapeFinale = {
  gameId: GAME,
  title: 'Vault Heist',
  finale: 'The vault is empty. Well played.',
  ranking: [
    row({}),
    row({ teamId: 't2', name: 'Owls', place: 2, scoreMs: 1_800_000, hintsUsed: 1, paidHints: 0 }),
    row({
      teamId: 't3',
      name: 'Moles',
      place: 3,
      scoreMs: null,
      escaped: false,
      stagesCleared: 2,
      hintsUsed: 0,
      paidHints: 0,
    }),
  ],
  awards: { fastest: 't1', fewestHints: 't3', teamwork: null, photoFinish: ['t1', 't2'] },
};

const rows = () => within(screen.getByRole('list', { name: 'Ranking' })).getAllByRole('listitem');

describe('EscapeFinaleView', () => {
  it('ranks the teams: place, name, time or stages, hints with the paid ones in brackets', () => {
    drawEn(<EscapeFinaleView finale={finale} myTeamId={null} closed={false} />);
    expect(screen.getByRole('heading', { name: 'Vault Heist' })).toBeInTheDocument();
    expect(screen.getByText('The vault is empty. Well played.')).toBeInTheDocument();
    const [a, b, c] = rows();
    expect(a).toHaveTextContent('1');
    expect(a).toHaveTextContent('Red Foxes');
    expect(a).toHaveTextContent('25:00');
    expect(a).toHaveTextContent('3 hints (2 paid)');
    expect(b).toHaveTextContent('Owls');
    expect(b).toHaveTextContent('1 hint');
    expect(c).toHaveTextContent('Stages: 2');
    expect(c).toHaveTextContent('0 hints');
  });

  it('names the awards and their teams', () => {
    drawEn(<EscapeFinaleView finale={finale} myTeamId={null} closed={false} />);
    const awards = within(screen.getByRole('list', { name: 'Awards' })).getAllByRole('listitem');
    expect(awards.map((li) => li.textContent)).toEqual([
      'FastestRed Foxes',
      'Fewest hintsMoles',
      'Photo finishRed Foxes · Owls',
    ]);
  });

  it('marks my team with aria-current', () => {
    drawEn(<EscapeFinaleView finale={finale} myTeamId="t2" closed={false} />);
    const [a, b] = rows();
    expect(b).toHaveAttribute('aria-current', 'true');
    expect(b).toHaveTextContent('Your team');
    expect(a).not.toHaveAttribute('aria-current');
  });

  it('once the room is closed: says so, and leads to another room', () => {
    const { rerender } = drawEn(
      <EscapeFinaleView finale={finale} myTeamId={null} closed={false} />,
    );
    expect(screen.queryByText('The room is closed')).toBeNull();
    rerender(
      <I18nextProvider i18n={i18n.cloneInstance({ lng: 'en' })}>
        <EscapeFinaleView finale={finale} myTeamId={null} closed />
      </I18nextProvider>,
    );
    expect(screen.getByText('The room is closed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Join another room' })).toHaveAttribute(
      'href',
      '/join',
    );
  });
});
