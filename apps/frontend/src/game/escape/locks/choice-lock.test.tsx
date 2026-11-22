import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { drawEn, lock } from '../test-fixtures';
import { ChoiceLock } from './choice-lock';

const choice = (image: (i: number) => string | null = () => null) =>
  lock({
    id: 'shelf',
    kind: 'choice',
    label: 'Bookshelf',
    options: ['Red book', 'Blue book', 'Green book'].map((label, i) => ({
      id: `o${i}`,
      label,
      image: image(i),
    })),
  });

describe('ChoiceLock', () => {
  it('toggles any number of options and sends the selected ids', () => {
    const submit = vi.fn().mockResolvedValue({ ok: true, outcome: 'wrong' });
    drawEn(<ChoiceLock lock={choice()} block={null} submit={submit} />);
    const open = screen.getByRole('button', { name: 'Open' });
    expect(open).toBeDisabled();
    const red = screen.getByRole('button', { name: 'Red book' });
    const green = screen.getByRole('button', { name: 'Green book' });
    expect(red).toHaveAttribute('aria-pressed', 'false');
    expect(red.className).toMatch(/min-h-12/);
    fireEvent.click(green);
    fireEvent.click(red);
    expect(red).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Blue book' }));
    fireEvent.click(screen.getByRole('button', { name: 'Blue book' }));
    expect(open).toBeEnabled();
    fireEvent.click(open);
    expect(submit).toHaveBeenCalledWith('shelf', ['o0', 'o2']);
  });

  it('picture options show as an image grid', () => {
    const { container } = drawEn(
      <ChoiceLock
        lock={choice((i) => `https://cdn.example.org/${i}.png`)}
        block={null}
        submit={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-layout="images"]')).not.toBeNull();
    const red = screen.getByRole('button', { name: 'Red book' });
    fireEvent.click(red);
    expect(red).toHaveAttribute('aria-pressed', 'true');
  });

  it('an unsafe picture falls back to text tiles', () => {
    const { container } = drawEn(
      <ChoiceLock lock={choice(() => 'javascript:alert(1)')} block={null} submit={vi.fn()} />,
    );
    expect(container.querySelector('[data-layout="images"]')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });
});
