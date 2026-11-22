import type { EscapeSubmitAck } from '@quiz-dock/contracts';
import { act, fireEvent, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import i18n from '../../../i18n';
import { drawEn, lock } from '../test-fixtures';
import { CodeLock } from './code-lock';
import type { LockBlock } from './lock-card';

const ok = (outcome: 'wrong' | 'lock-solved'): EscapeSubmitAck => ({ ok: true, outcome });
const no = (reason: string, retryAfterMs?: number) =>
  ({ ok: false, reason, ...(retryAfterMs ? { retryAfterMs } : {}) }) as EscapeSubmitAck;

const input = () => screen.getByRole('textbox', { name: 'Answer for Keypad' });
const button = () => screen.getByRole('button', { name: 'Open' });
const type = (v: string) => fireEvent.change(input(), { target: { value: v } });

afterEach(() => vi.useRealTimers());

describe('LockCard (shared lock behaviour)', () => {
  it('shows the label and the kind; a solved lock says Opened, with no input', () => {
    const { rerender } = drawEn(<CodeLock lock={lock()} block={null} submit={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /Keypad/ })).toHaveTextContent('Code');
    expect(input()).toBeInTheDocument();
    rerender(
      <I18nextProvider i18n={i18n.cloneInstance({ lng: 'en' })}>
        <CodeLock lock={lock({ solved: true })} block={null} submit={vi.fn()} />
      </I18nextProvider>,
    );
    expect(screen.getByText('Opened')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
  });

  it('a large submit button, busy while the ack is pending: a double tap sends once', async () => {
    let resolve!: (a: EscapeSubmitAck) => void;
    const submit = vi.fn(() => new Promise<EscapeSubmitAck>((r) => (resolve = r)));
    drawEn(<CodeLock lock={lock()} block={null} submit={submit} />);
    type('1234');
    expect(button().className).toMatch(/min-h-12/);
    fireEvent.click(button());
    fireEvent.click(button());
    expect(submit).toHaveBeenCalledTimes(1);
    expect(button()).toHaveAttribute('aria-busy', 'true');
    expect(button()).toBeDisabled();
    await act(async () => resolve(ok('lock-solved')));
    expect(button()).not.toHaveAttribute('aria-busy');
  });

  it('keeps the draft across a new state', () => {
    const { rerender } = drawEn(<CodeLock lock={lock()} block={null} submit={vi.fn()} />);
    type('42');
    rerender(
      <I18nextProvider i18n={i18n.cloneInstance({ lng: 'en' })}>
        <CodeLock lock={lock()} block={null} submit={vi.fn()} />
      </I18nextProvider>,
    );
    expect(input()).toHaveValue('42');
  });

  it('wrong: Not quite, the draft kept and selected', async () => {
    const submit = vi.fn().mockResolvedValue(ok('wrong'));
    drawEn(<CodeLock lock={lock()} block={null} submit={submit} />);
    type('1111');
    fireEvent.click(button());
    expect(await screen.findByText('Not quite')).toBeInTheDocument();
    const el = input() as HTMLInputElement;
    expect(el).toHaveValue('1111');
    expect(el).toHaveFocus();
    expect([el.selectionStart, el.selectionEnd]).toEqual([0, 4]);
  });

  it('rate-limited: disabled with a countdown', async () => {
    vi.useFakeTimers();
    const submit = vi.fn().mockResolvedValue(no('rate-limited', 12_000));
    drawEn(<CodeLock lock={lock()} block={null} submit={submit} />);
    type('1');
    fireEvent.click(button());
    // The ack: a resolved promise, flushed without the (fake) clock moving.
    await act(async () => {});
    expect(screen.getByText('Try again in 12 s')).toBeInTheDocument();
    expect(input()).toBeDisabled();
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByText('Try again in 10 s')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(10_000));
    expect(input()).toBeEnabled();
    expect(screen.queryByText(/Try again in/)).toBeNull();
  });

  it.each([
    ['paused', 'The game is paused'],
    ['time-up', "Time's up"],
    ['not-running', 'The game is not running'],
  ])('a %s refusal shows its text and disables the input', async (reason, text) => {
    const submit = vi.fn().mockResolvedValue(no(reason));
    drawEn(<CodeLock lock={lock()} block={null} submit={submit} />);
    type('1');
    fireEvent.click(button());
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(input()).toBeDisabled();
  });

  it.each<[LockBlock, string]>([
    ['paused', 'The game is paused'],
    ['time-up', "Time's up"],
    ['offline', 'No connection. Waiting to reconnect…'],
    ['escaped', 'Your team has escaped'],
  ])('blocked (%s) by the run: its text, input disabled', (block, text) => {
    drawEn(<CodeLock lock={lock()} block={block} submit={vi.fn()} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(input()).toBeDisabled();
    expect(button()).toBeDisabled();
  });

  it('offline: the input is disabled, nothing queued', () => {
    drawEn(<CodeLock lock={lock()} block="offline" submit={vi.fn()} />);
    expect(input()).toBeDisabled();
  });

  it('a send that fails says so and keeps the draft', async () => {
    const submit = vi.fn().mockRejectedValue(new Error('timeout'));
    drawEn(<CodeLock lock={lock()} block={null} submit={submit} />);
    type('9');
    fireEvent.click(button());
    expect(await screen.findByText('Could not send. Check your connection.')).toBeInTheDocument();
    expect(input()).toHaveValue('9');
    expect(input()).toBeEnabled();
  });
});
