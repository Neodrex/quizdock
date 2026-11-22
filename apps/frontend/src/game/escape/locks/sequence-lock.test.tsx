import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { drawEn, lock } from '../test-fixtures';
import { SequenceLock } from './sequence-lock';

const seq = lock({
  id: 'bells',
  kind: 'sequence',
  label: 'Bells',
  items: [
    { id: 'c', label: 'Crow' },
    { id: 'a', label: 'Ant' },
    { id: 'b', label: 'Bee' },
  ],
});

const shown = () =>
  within(screen.getByRole('list', { name: 'Bells' }))
    .getAllByRole('listitem')
    .map((li) => li.textContent?.match(/Crow|Ant|Bee/)?.[0]);

describe('SequenceLock', () => {
  it("starts in the server's order and sends the shown order", () => {
    const submit = vi.fn().mockResolvedValue({ ok: true, outcome: 'wrong' });
    drawEn(<SequenceLock lock={seq} block={null} submit={submit} />);
    expect(shown()).toEqual(['Crow', 'Ant', 'Bee']);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(submit).toHaveBeenCalledWith('bells', ['c', 'a', 'b']);
  });

  it('reorders with labelled up and down buttons', () => {
    const submit = vi.fn().mockResolvedValue({ ok: true, outcome: 'wrong' });
    drawEn(<SequenceLock lock={seq} block={null} submit={submit} />);
    expect(screen.getByRole('button', { name: 'Move Crow up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Bee down' })).toBeDisabled();
    const up = screen.getByRole('button', { name: 'Move Ant up' });
    expect(up.className).toMatch(/min-h-12/);
    fireEvent.click(up);
    expect(shown()).toEqual(['Ant', 'Crow', 'Bee']);
    fireEvent.click(screen.getByRole('button', { name: 'Move Crow down' }));
    expect(shown()).toEqual(['Ant', 'Bee', 'Crow']);
    expect(screen.getByRole('button', { name: 'Drag Ant' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(submit).toHaveBeenCalledWith('bells', ['a', 'b', 'c']);
  });
});
