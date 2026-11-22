import { act, fireEvent, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import { LiveMotion } from '../motion/level';
import type { Overlay } from './escape-reducer';
import { drawEn } from './test-fixtures';
import { STAGE_TITLE_ID, UNLOCK_MS, UnlockMoment } from './unlock-moment';

const en = i18n.cloneInstance({ lng: 'en' });
const vibrate = vi.fn();

const stage: Overlay = { kind: 'stage', unlockText: 'The door creaks open.', stageIndex: 0 };

function Page({
  overlay,
  onClose,
  on = true,
}: {
  overlay: Overlay | null;
  onClose: () => void;
  on?: boolean;
}) {
  return (
    <LiveMotion on={on}>
      <h2 id={STAGE_TITLE_ID} tabIndex={-1}>
        The library
      </h2>
      <UnlockMoment overlay={overlay} onClose={onClose} />
    </LiveMotion>
  );
}

beforeEach(() => {
  Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
});
afterEach(() => {
  vi.useRealTimers();
  vibrate.mockReset();
});

describe('UnlockMoment', () => {
  it('a cleared stage shows its unlock text and the next stage, and vibrates once', () => {
    drawEn(<Page overlay={stage} onClose={vi.fn()} />);
    expect(screen.getByText('The door creaks open.')).toBeInTheDocument();
    expect(screen.getByText('Stage 2 unlocked')).toBeInTheDocument();
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledWith([80, 40, 120]);
  });

  it('closes after 2.5 s, then focus is on the new stage title', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { rerender } = drawEn(<Page overlay={stage} onClose={onClose} />);
    act(() => vi.advanceTimersByTime(UNLOCK_MS - 1));
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(UNLOCK_MS).toBe(2500);
    rerender(
      <I18nextProvider i18n={en}>
        <Page overlay={null} onClose={onClose} />
      </I18nextProvider>,
    );
    expect(screen.getByRole('heading', { name: 'The library' })).toHaveFocus();
  });

  it('closes on a tap', () => {
    const onClose = vi.fn();
    drawEn(<Page overlay={stage} onClose={onClose} />);
    fireEvent.click(screen.getByText('The door creaks open.'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('animates with full motion, and not at all with motion off', () => {
    const { rerender } = drawEn(<Page overlay={stage} onClose={vi.fn()} />);
    expect(screen.getByTestId('unlock-moment')).toHaveAttribute('data-motion', 'full');
    rerender(
      <I18nextProvider i18n={en}>
        <Page overlay={{ ...stage }} onClose={vi.fn()} on={false} />
      </I18nextProvider>,
    );
    const el = screen.getByTestId('unlock-moment');
    expect(el).toHaveAttribute('data-motion', 'none');
    // No motion styles left on a static overlay.
    expect(el.getAttribute('style')).toBeNull();
  });

  it('escaped: the final unlock text and You escaped!', () => {
    drawEn(<Page overlay={{ kind: 'escaped', unlockText: 'Daylight!' }} onClose={vi.fn()} />);
    expect(screen.getByText('Daylight!')).toBeInTheDocument();
    expect(screen.getByText('You escaped!')).toBeInTheDocument();
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it('never stacks: a second overlay replaces the first and restarts its time', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { rerender } = drawEn(<Page overlay={stage} onClose={onClose} />);
    act(() => vi.advanceTimersByTime(2000));
    rerender(
      <I18nextProvider i18n={en}>
        <Page overlay={{ kind: 'escaped', unlockText: 'Daylight!' }} onClose={onClose} />
      </I18nextProvider>,
    );
    expect(screen.getAllByTestId('unlock-moment')).toHaveLength(1);
    expect(screen.queryByText('The door creaks open.')).toBeNull();
    act(() => vi.advanceTimersByTime(1000));
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1500));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledTimes(2);
  });

  it('two stages with the same unlock text each play their moment', () => {
    const { rerender } = drawEn(<Page overlay={stage} onClose={vi.fn()} />);
    const first = screen.getByTestId('unlock-moment');
    rerender(
      <I18nextProvider i18n={en}>
        <Page overlay={{ ...stage, stageIndex: 1 }} onClose={vi.fn()} />
      </I18nextProvider>,
    );
    expect(screen.getByText('Stage 3 unlocked')).toBeInTheDocument();
    expect(screen.getByTestId('unlock-moment')).not.toBe(first);
  });

  it('without vibration support nothing breaks', () => {
    // @ts-expect-error: a browser with no Vibration API
    delete navigator.vibrate;
    drawEn(<Page overlay={stage} onClose={vi.fn()} />);
    expect(screen.getByText('Stage 2 unlocked')).toBeInTheDocument();
  });
});
