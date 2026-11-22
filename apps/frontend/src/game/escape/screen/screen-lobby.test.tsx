import type { EscapeBoard, EscapeRosterEntry } from '@quiz-dock/contracts';
import { screen, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import { drawEn, en } from '../test-fixtures';
import { boardOf, summaryOf } from './screen-fixtures';
import { ScreenLobby } from './screen-lobby';

vi.mock('qrcode.react', () => ({
  QRCodeSVG: (p: { value: string; 'aria-label'?: string; className?: string }) => (
    <svg role="img" data-value={p.value} aria-label={p['aria-label']} className={p.className} />
  ),
}));

const VIEW = { joinBaseUrl: 'https://quiz.example' };
const PIN = '123456';

const red = summaryOf();
const blue = summaryOf({ id: 't2', name: 'Team Blue', memberCount: 1 });
const entry = (nickname: string, teamId: string | null, connected = true): EscapeRosterEntry => ({
  teamId,
  nickname,
  connected,
});

const forming = (over: Partial<EscapeBoard> = {}) =>
  boardOf({ phase: 'forming', teams: [red, blue], ...over });

const draw = (board: EscapeBoard) => drawEn(<ScreenLobby board={board} pin={PIN} view={VIEW} />);

const card = (name: string) =>
  screen.getByText(name, { selector: 'li > div > span' }).closest('li')!;
/** The text a screen reader reads: aria-hidden subtrees left out. */
const spoken = (el: Element) => {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
  return copy.textContent?.replace(/\s+/g, ' ').trim() ?? '';
};

describe('ScreenLobby', () => {
  it('shows the PIN in large digits, the QR of the join link and the join address', () => {
    draw(forming());
    const pin = screen.getByTestId('lobby-pin');
    expect(spoken(pin)).toBe('PIN 1 2 3 4 5 6');
    expect(within(pin).getByText('123456')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('img', { name: 'QR code to join' })).toHaveAttribute(
      'data-value',
      'https://quiz.example/join/123456',
    );
    expect(screen.getByText('quiz.example/join')).toBeInTheDocument();
  });

  it('gives each team card its count, its players by nickname and an offline mark', () => {
    draw(
      forming({
        formation: { mode: 'auto', maxSize: 5 },
        roster: [entry('Ana', 't1'), entry('Ben', 't1', false), entry('Cy', 't2')],
      }),
    );
    const r = card('Team Red');
    expect(within(r).getByText('3 / 5')).toBeInTheDocument();
    expect(within(r).getByText('Ana')).toBeInTheDocument();
    const ben = within(r).getByText('Ben').closest('li')!;
    expect(within(ben).getByLabelText('Offline')).toBeInTheDocument();
    expect(within(card('Team Blue')).getByText('Cy')).toBeInTheDocument();
  });

  it('counts players without a cap, and lists the ones waiting for a team', () => {
    draw(forming({ roster: [entry('Zoe', null), entry('Ana', 't1')], unassigned: 1 }));
    expect(within(card('Team Red')).getByText('3 players')).toBeInTheDocument();
    const waiting = screen.getByRole('list', { name: 'Waiting for a team' });
    expect(within(waiting).getByText('Zoe')).toBeInTheDocument();
  });

  it('says to pick a team on the phone in self formation, and not in auto', () => {
    const { unmount } = draw(forming({ formation: { mode: 'self', maxSize: null } }));
    expect(screen.getByText('Pick your team on your phone')).toBeInTheDocument();
    unmount();
    draw(forming());
    expect(screen.queryByText('Pick your team on your phone')).toBeNull();
  });

  it('follows the boards: a new player shows in their card, a moved one changes card', () => {
    const at = (roster: EscapeRosterEntry[]) => (
      <I18nextProvider i18n={en}>
        <ScreenLobby board={forming({ roster })} pin={PIN} view={VIEW} />
      </I18nextProvider>
    );
    const { rerender } = drawEn(<ScreenLobby board={forming()} pin={PIN} view={VIEW} />);
    rerender(at([entry('Ana', 't1')]));
    expect(within(card('Team Red')).getByText('Ana')).toBeInTheDocument();
    rerender(at([entry('Ana', 't2')]));
    expect(within(card('Team Red')).queryByText('Ana')).toBeNull();
    expect(within(card('Team Blue')).getByText('Ana')).toBeInTheDocument();
  });

  it('cuts long nicknames on one line, and shows 8 names then "+3"', () => {
    const names = Array.from({ length: 11 }, (_, i) => `Player number ${i + 1} with a long name`);
    draw(forming({ roster: names.map((n) => entry(n, 't1')) }));
    const r = card('Team Red');
    expect(within(r).getByText(names[0])).toHaveClass('truncate');
    expect(within(r).getByText(names[7])).toBeInTheDocument();
    expect(within(r).queryByText(names[8])).toBeNull();
    expect(within(r).getByText('+3')).toBeInTheDocument();
  });

  it('before teams exist: waits for the host and counts the players', () => {
    draw(forming({ teams: [], unassigned: 2, roster: [entry('Ana', null), entry('Ben', null)] }));
    expect(screen.getByText('Waiting for the host to form teams')).toBeInTheDocument();
    expect(screen.getByText('2 players in the room')).toBeInTheDocument();
  });

  it('from 13 teams, a card shows 3 names and counts the rest', () => {
    const teams = Array.from({ length: 13 }, (_, i) =>
      summaryOf({ id: `t${i}`, name: `Team ${i}` }),
    );
    draw(forming({ teams, roster: ['Ana', 'Ben', 'Cy', 'Dee'].map((n) => entry(n, 't0')) }));
    const c = card('Team 0');
    expect(within(c).getByText('Cy')).toBeInTheDocument();
    expect(within(c).queryByText('Dee')).toBeNull();
    expect(within(c).getByText('+1')).toBeInTheDocument();
  });

  it.each([
    [2, 'grid-cols-2'],
    [6, 'grid-cols-3'],
    [12, 'grid-cols-4'],
    [20, 'grid-cols-5'],
    [30, 'grid-cols-6'],
    [31, 'grid-cols-8'],
  ])('lays %i teams out without scrolling (%s)', (count, cols) => {
    const teams = Array.from({ length: count }, (_, i) =>
      summaryOf({ id: `t${i}`, name: `Team ${i}` }),
    );
    draw(forming({ teams }));
    const grid = screen.getByRole('list', { name: 'Teams' });
    expect(grid).toHaveClass(cols);
    expect(grid.className).not.toMatch(/overflow-(auto|scroll|y-auto)/);
    expect(grid.querySelectorAll(':scope > li')).toHaveLength(count);
    expect(grid.querySelector(':scope > li[aria-label]')).toBeNull();
  });
});
