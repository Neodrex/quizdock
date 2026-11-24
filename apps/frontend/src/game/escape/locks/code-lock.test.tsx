import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { drawEn, lock } from '../test-fixtures';
import { CodeLock } from './code-lock';

describe('CodeLock', () => {
  it('sends the trimmed code', () => {
    const submit = vi.fn().mockResolvedValue({ ok: true, outcome: 'lock-solved' });
    drawEn(<CodeLock lock={lock()} block={null} submit={submit} />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('maxlength', '200');
    expect(screen.getByRole('button', { name: 'Open' })).toBeDisabled();
    fireEvent.change(input, { target: { value: '  ab 12 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(submit).toHaveBeenCalledWith('pad', 'ab 12');
  });

  it('a number pad for digits, a plain code keyboard otherwise', () => {
    const { unmount } = drawEn(
      <CodeLock lock={lock({ digits: true })} block={null} submit={vi.fn()} />,
    );
    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).toHaveAttribute('autocapitalize', 'characters');
    expect(input).toHaveAttribute('spellcheck', 'false');
    // At least 16 px, so iOS does not zoom in.
    expect(input.className).toMatch(/text-base/);
    unmount();
    drawEn(<CodeLock lock={lock()} block={null} submit={vi.fn()} />);
    expect(screen.getByRole('textbox')).not.toHaveAttribute('inputmode', 'numeric');
  });
});
