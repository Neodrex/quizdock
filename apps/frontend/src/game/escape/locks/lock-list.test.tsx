import { act, fireEvent, screen, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import i18n from '../../../i18n';
import { drawEn, lock, state, team, view } from '../test-fixtures';
import { blockOf, LockList } from './lock-list';

const en = i18n.cloneInstance({ lng: 'en' });
const three = (solved: string[] = []) =>
  view({
    locks: [
      lock({ id: 'a', label: 'Keypad', solved: solved.includes('a') }),
      lock({ id: 'b', label: 'Door', kind: 'phrase', solved: solved.includes('b') }),
      lock({ id: 'c', label: 'Chest', solved: solved.includes('c') }),
    ],
  });
const roles = state().roles;

describe('LockList (parallel locks)', () => {
  it('shows every unsolved lock of the stage, openable in any order', () => {
    const submit = vi.fn().mockResolvedValue({ ok: true, outcome: 'wrong' });
    drawEn(<LockList view={three()} roles={roles} block={null} submit={submit} />);
    expect(screen.getAllByRole('button', { name: 'Open' })).toHaveLength(3);
    fireEvent.change(screen.getByRole('textbox', { name: 'Answer for Chest' }), {
      target: { value: '9' },
    });
    const chest = screen.getByRole('heading', { name: /Chest/ }).closest('article')!;
    fireEvent.click(within(chest).getByRole('button', { name: 'Open' }));
    expect(submit).toHaveBeenCalledWith('c', '9');
  });

  it('says how many locks are open, and collapses the solved ones', () => {
    drawEn(<LockList view={three(['a', 'c'])} roles={roles} block={null} submit={vi.fn()} />);
    expect(screen.getByText('2 of 3 locks open')).toBeInTheDocument();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.getAllByText('Opened')).toHaveLength(2);
  });

  it('after my solve, the next unsolved lock gets focus', async () => {
    const submit = vi.fn().mockResolvedValue({ ok: true, outcome: 'lock-solved' });
    const { rerender } = drawEn(
      <LockList view={three()} roles={roles} block={null} submit={submit} />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Answer for Door' }), {
      target: { value: 'sesame' },
    });
    const door = screen.getByRole('heading', { name: /Door/ }).closest('article')!;
    await act(async () => {
      fireEvent.click(within(door).getByRole('button', { name: 'Open' }));
    });
    rerender(
      <I18nextProvider i18n={en}>
        <LockList view={three(['b'])} roles={roles} block={null} submit={submit} />
      </I18nextProvider>,
    );
    expect(screen.getByRole('heading', { name: /Chest/ })).toHaveFocus();
  });

  it('a single lock shows no count', () => {
    drawEn(<LockList view={view()} roles={roles} block={null} submit={vi.fn()} />);
    expect(screen.queryByText(/locks open/)).toBeNull();
  });
});

describe('blockOf', () => {
  it('offline first, then time up, pause and escape', () => {
    expect(blockOf(state(), false)).toBeNull();
    expect(blockOf(state(), true)).toBe('offline');
    expect(blockOf(state({ team: team({ timedOut: true }) }), false)).toBe('time-up');
    const paused = state({ clock: { ...state().clock, paused: true } });
    expect(blockOf(paused, false)).toBe('paused');
    expect(blockOf(state({ team: team({ escaped: true }) }), false)).toBe('escaped');
  });
});
