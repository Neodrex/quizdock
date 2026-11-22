import type { EscapeAskHintAck } from '@quiz-dock/contracts';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import { HintPanel } from './hint-panel';
import { drawEn, state, team, view } from './test-fixtures';

const en = i18n.cloneInstance({ lng: 'en' });

const withHints = (over: Parameters<typeof state>[0] = {}) =>
  state({
    view: view({
      hints: [
        { id: 'h1', text: 'Look under the rug.' },
        { id: 'h2', text: 'The clock is stopped at the code.' },
      ],
    }),
    nextHint: { id: 'h3', penaltyS: 60 },
    ...over,
  });

const hintButton = () => screen.getByRole('button', { name: /^Hint/ });

describe('HintPanel', () => {
  it('lists the released hints newest first, tagged free or paid when known', () => {
    drawEn(
      <HintPanel
        state={withHints()}
        hintTags={{ h1: 'free', h2: 'paid' }}
        canPlay
        askHint={vi.fn()}
      />,
    );
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining('The clock is stopped'),
      expect.stringContaining('Look under the rug'),
    ]);
    expect(items[0]).toHaveTextContent('Paid');
    expect(items[1]).toHaveTextContent('Free');
  });

  it('shows the Hint button with its cost only when a hint is offered and the team can play', () => {
    const { rerender } = drawEn(
      <HintPanel state={withHints()} hintTags={{}} canPlay askHint={vi.fn()} />,
    );
    expect(hintButton()).toHaveTextContent('Hint (+60 s)');
    expect(hintButton().className).toMatch(/min-h-12/);
    const draw = (s: ReturnType<typeof state>, canPlay = true) =>
      rerender(
        <I18nextProvider i18n={en}>
          <HintPanel state={s} hintTags={{}} canPlay={canPlay} askHint={vi.fn()} />
        </I18nextProvider>,
      );
    draw(withHints({ nextHint: { id: 'h3', penaltyS: 0 } }));
    expect(hintButton()).toHaveTextContent('Hint (free)');
    draw(withHints({ nextHint: null }));
    expect(screen.queryByRole('button', { name: /^Hint/ })).toBeNull();
    draw(withHints(), false);
    expect(screen.queryByRole('button', { name: /^Hint/ })).toBeNull();
  });

  it('asks for confirmation with the cost; Confirm sends once, Cancel sends nothing', async () => {
    let resolve!: (a: EscapeAskHintAck) => void;
    const askHint = vi.fn(() => new Promise<EscapeAskHintAck>((r) => (resolve = r)));
    drawEn(<HintPanel state={withHints()} hintTags={{}} canPlay askHint={askHint} />);

    fireEvent.click(hintButton());
    expect(screen.getByText("This hint adds 60 s to your team's time.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(askHint).not.toHaveBeenCalled();

    fireEvent.click(hintButton());
    const confirm = screen.getByRole('button', { name: 'Get the hint' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(askHint).toHaveBeenCalledTimes(1);
    expect(askHint).toHaveBeenCalledWith('h3');
    await act(async () => resolve({ ok: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a hint asked for is not asked again before the next state offers another', async () => {
    const askHint = vi.fn().mockResolvedValue({ ok: true });
    drawEn(<HintPanel state={withHints()} hintTags={{}} canPlay askHint={askHint} />);
    fireEvent.click(hintButton());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Get the hint' }));
    });
    // The state still offers h3: a second ask in that gap sends nothing.
    fireEvent.click(hintButton());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Get the hint' }));
    });
    expect(askHint).toHaveBeenCalledTimes(1);
  });

  it('a refused ask (rate-limited) can be asked again before the next state', async () => {
    const askHint = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'rate-limited' })
      .mockResolvedValueOnce({ ok: true });
    drawEn(<HintPanel state={withHints()} hintTags={{}} canPlay askHint={askHint} />);
    fireEvent.click(hintButton());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Get the hint' }));
    });
    fireEvent.click(hintButton());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Get the hint' }));
    });
    expect(askHint).toHaveBeenCalledTimes(2);
  });

  it('a free hint says so in the confirmation', () => {
    drawEn(
      <HintPanel
        state={withHints({ nextHint: { id: 'h3', penaltyS: 0 } })}
        hintTags={{}}
        canPlay
        askHint={vi.fn()}
      />,
    );
    fireEvent.click(hintButton());
    expect(screen.getByText('This hint is free.')).toBeInTheDocument();
  });

  it('no-hint (a teammate took it first) closes the dialog', async () => {
    const askHint = vi.fn().mockResolvedValue({ ok: false, reason: 'no-hint' });
    drawEn(<HintPanel state={withHints()} hintTags={{}} canPlay askHint={askHint} />);
    fireEvent.click(hintButton());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Get the hint' }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a failed send keeps the dialog open and says so', async () => {
    const askHint = vi.fn().mockRejectedValue(new Error('timeout'));
    drawEn(<HintPanel state={withHints()} hintTags={{}} canPlay askHint={askHint} />);
    fireEvent.click(hintButton());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Get the hint' }));
    });
    expect(screen.getByText('Could not send. Check your connection.')).toBeInTheDocument();
  });

  it('shows the hint penalty total', () => {
    drawEn(
      <HintPanel
        state={withHints({ team: team({ hintPenaltyS: 120 }) })}
        hintTags={{}}
        canPlay
        askHint={vi.fn()}
      />,
    );
    expect(screen.getByText('Hints: +2:00')).toBeInTheDocument();
  });

  it('a host or timed hint shows as it arrives, with no tap', () => {
    const { rerender } = drawEn(
      <HintPanel state={withHints()} hintTags={{}} canPlay askHint={vi.fn()} />,
    );
    rerender(
      <I18nextProvider i18n={en}>
        <HintPanel
          state={state({
            view: view({
              hints: [
                { id: 'h1', text: 'Look under the rug.' },
                { id: 'h2', text: 'The clock is stopped at the code.' },
                { id: 'hx', text: 'From the host: try the painting.' },
              ],
            }),
          })}
          hintTags={{ hx: 'free' }}
          canPlay
          askHint={vi.fn()}
        />
      </I18nextProvider>,
    );
    expect(within(screen.getByRole('list')).getAllByRole('listitem')[0]).toHaveTextContent(
      'From the host: try the painting.',
    );
  });

  it('with no hint released and none offered, shows nothing', () => {
    const { container } = drawEn(
      <HintPanel state={state({ nextHint: null })} hintTags={{}} canPlay askHint={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
