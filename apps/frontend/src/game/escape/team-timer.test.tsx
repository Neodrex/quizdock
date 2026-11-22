import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import { formatClock, TeamTimer } from './team-timer';

const en = i18n.cloneInstance({ lng: 'en' });

function draw(remainingMs: number, paused = false) {
  return render(
    <I18nextProvider i18n={en}>
      <TeamTimer remainingMs={remainingMs} paused={paused} />
    </I18nextProvider>,
  );
}

describe('TeamTimer', () => {
  it('formats mm:ss, and h:mm:ss from an hour up', () => {
    expect(formatClock(299_000)).toBe('4:59');
    expect(formatClock(59_001)).toBe('1:00'); // rounded up: 0:00 only at the end
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(3_600_000)).toBe('1:00:00');
    expect(formatClock(3_725_000)).toBe('1:02:05');
  });

  it('labels the time once a minute, not every second', () => {
    const { rerender } = draw(300_000);
    const timer = screen.getByRole('timer');
    expect(timer).toHaveTextContent('5:00');
    expect(timer).toHaveAccessibleName('Time left: 5 minutes 0 seconds');
    const at = (ms: number) =>
      rerender(
        <I18nextProvider i18n={en}>
          <TeamTimer remainingMs={ms} paused={false} />
        </I18nextProvider>,
      );
    at(299_000);
    expect(timer).toHaveAccessibleName('Time left: 4 minutes 59 seconds');
    at(298_000);
    expect(timer).toHaveTextContent('4:58');
    expect(timer).toHaveAccessibleName('Time left: 4 minutes 59 seconds');
    at(239_000);
    expect(timer).toHaveAccessibleName('Time left: 3 minutes 59 seconds');
  });

  it('says when it is paused, and warns in the last minutes', () => {
    draw(45_000, true);
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveAttribute('data-warning', 'last-minute');
  });
});
