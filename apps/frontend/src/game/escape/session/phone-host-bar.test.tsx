import type { EscapePlayerState } from '@quiz-dock/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { phoneHostRoomOf } from '../host/use-phone-host';
import { hostStateOf, hostTeamOf } from '../host/host-fixtures';
import { drawEn, state } from '../test-fixtures';
import { PhoneHostBar } from './phone-host-bar';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    className,
    params,
  }: {
    children: ReactNode;
    className?: string;
    params: { pin: string };
  }) => (
    <a href={`/session/${params.pin}/console`} className={className}>
      {children}
    </a>
  ),
}));

const PIN = '482913';
const host = { isPhoneHost: true, type: 'group' as const, raceFormat: null, startsAt: null };
const lobby = (over: Partial<EscapePlayerState> = {}) =>
  state({ phase: 'forming', session: host, view: null, ...over });

function bar(
  s: EscapePlayerState,
  room = { joined: 4, cap: 6, ready: true },
  send = vi.fn().mockResolvedValue({ ok: true }),
) {
  drawEn(<PhoneHostBar pin={PIN} state={s} room={room} send={send} />);
  return send;
}
const region = () => screen.getByRole('region', { name: 'Host controls' });

describe('PhoneHostBar', () => {
  it('lobby: Start, the seats and Open console', () => {
    const send = bar(lobby());
    const r = within(region());
    expect(r.getByText('4 / 6')).toHaveAccessibleName('Players in the room: 4 of 6');
    expect(r.getByRole('link', { name: 'Open console' })).toHaveAttribute(
      'href',
      `/session/${PIN}/console`,
    );
    fireEvent.click(r.getByRole('button', { name: 'Start' }));
    expect(send).toHaveBeenCalledWith('escape:start', { pin: PIN });
  });

  it('lobby: Start waits until someone is in a team', () => {
    bar(lobby(), { joined: 2, cap: 6, ready: false });
    const start = screen.getByRole('button', { name: 'Start' });
    expect(start).toBeDisabled();
    expect(start).toHaveAccessibleDescription('Waiting for a player in a team');
  });

  it('lobby: no waiting hint once Start can go', () => {
    bar(lobby());
    expect(screen.getByRole('button', { name: 'Start' })).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText('Waiting for a player in a team')).toBeNull();
  });

  it('running: Pause, then Resume when paused', () => {
    const send = bar(state({ session: host }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(send).toHaveBeenCalledWith('escape:pause', { pin: PIN, paused: true });
  });

  it('running and paused: Resume', () => {
    const send = bar(
      state({ session: host, clock: { serverNow: 1, paused: true, elapsedMs: 0, limitMs: 1 } }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(send).toHaveBeenCalledWith('escape:pause', { pin: PIN, paused: false });
  });

  it('running: a hint for my team shows its cost, then sends it for this team only', async () => {
    const send = bar(state({ session: host, nextHint: { id: 'h2', penaltyS: 60 } }));
    fireEvent.click(screen.getByRole('button', { name: 'Hint for my team' }));
    const dialog = screen.getByRole('dialog', { name: 'Give your team its next hint?' });
    expect(dialog).toHaveTextContent('It adds 60 s to your team’s score.');
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Give the hint' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('escape:hint', { pin: PIN, teamId: 't1', hintId: 'h2' }),
    );
  });

  it('running: no hint left, no hint button to press', () => {
    bar(state({ session: host, nextHint: null }));
    expect(screen.getByRole('button', { name: 'Hint for my team' })).toBeDisabled();
  });

  it('running: End asks first', async () => {
    const send = bar(state({ session: host }));
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    const dialog = screen.getByRole('dialog', { name: 'End the game for everyone?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'End now' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('escape:end', { pin: PIN }));
  });

  it('a refusal shows its text', async () => {
    const send = vi.fn().mockRejectedValue(
      Object.assign(new Error('Not possible at this point of the game.'), {
        code: 'escape.wrong_phase',
      }),
    );
    bar(state({ session: host }), undefined, send);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not possible at this point of the game.',
    );
  });

  it('finale: show the finale again', () => {
    const send = bar(state({ session: host, phase: 'finale' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show the finale again' }));
    expect(send).toHaveBeenCalledWith('escape:finale', { pin: PIN });
  });

  it('tap targets of 48 px, and a sticky footer in the page’s flow', () => {
    bar(state({ session: host }));
    for (const b of within(region()).getAllByRole('button'))
      expect(b.className).toMatch(/min-h-12/);
    expect(region().className).toMatch(/sticky/);
    expect(region().className).toMatch(/bottom-0/);
    expect(region().className).not.toMatch(/\bfixed\b/);
  });

  it('keeps counts only from the host state: no other team’s details', () => {
    const room = phoneHostRoomOf(
      hostStateOf({
        session: { type: 'group', cap: 6, joined: 5, race: null, licence: null, tools: [] },
        teams: [hostTeamOf(), hostTeamOf({ id: 't2', name: 'Bats', members: [] })],
      }),
    );
    expect(room).toEqual({ joined: 5, cap: 6, ready: true });
    bar(state({ session: host, phase: 'forming', team: null }), room);
    expect(region().textContent).not.toMatch(/Bats|Team Red|Ana|Ben/);
  });
});
