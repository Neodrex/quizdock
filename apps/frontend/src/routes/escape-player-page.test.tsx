import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { drawEn, state, team } from '../game/escape/test-fixtures';
import { EscapedView, TimeUpView } from './escape-player-page';

describe('end-of-run screens', () => {
  it('escaped: the final unlock text, You escaped!, the time at the escape, the wait', () => {
    drawEn(
      <EscapedView
        state={state({ team: team({ escaped: true }) })}
        unlockText="Daylight!"
        timeMs={1_234_000}
      />,
    );
    expect(screen.getByRole('heading', { name: 'You escaped!' })).toBeInTheDocument();
    expect(screen.getByText('Daylight!')).toBeInTheDocument();
    expect(screen.getByText('Red Foxes escaped in 20:34')).toBeInTheDocument();
    expect(screen.getByText('Waiting for the other teams')).toBeInTheDocument();
  });

  it("time up: Time's up and the stages cleared", () => {
    drawEn(<TimeUpView state={state({ team: team({ timedOut: true, stageIndex: 2 }) })} />);
    expect(screen.getByRole('heading', { name: "Time's up" })).toBeInTheDocument();
    expect(screen.getByText('Stages cleared: 2 of 4')).toBeInTheDocument();
  });
});
