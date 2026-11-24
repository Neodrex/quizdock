import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { drawEn, lock } from '../test-fixtures';
import { PhraseLock } from './phrase-lock';

describe('PhraseLock', () => {
  it('sends the phrase as typed: the server normalises it', () => {
    const submit = vi.fn().mockResolvedValue({ ok: true, outcome: 'lock-solved' });
    drawEn(
      <PhraseLock
        lock={lock({ id: 'door', kind: 'phrase', label: 'Door' })}
        block={null}
        submit={submit}
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Answer for Door' });
    expect(input.className).toMatch(/text-base/);
    // The contract's limit: a longer answer would fail validation as a generic "send failed".
    expect(input).toHaveAttribute('maxlength', '200');
    fireEvent.change(input, { target: { value: ' Open Sesame! ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(submit).toHaveBeenCalledWith('door', ' Open Sesame! ');
  });

  it('a blank phrase cannot be sent', () => {
    drawEn(<PhraseLock lock={lock({ kind: 'phrase' })} block={null} submit={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Open' })).toBeDisabled();
  });
});
