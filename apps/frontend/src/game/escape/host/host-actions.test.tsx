import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorText } from '@/api/error-text';
import { refusalError } from '../../game-client';
import { drawEn } from '../test-fixtures';
import { hostTeamOf, outlineOf } from './host-fixtures';
import {
  GiveHintButton,
  type HostCommands,
  RunBar,
  TeamActions,
  TimeControls,
  UnlockButton,
} from './host-actions';

// The quiz console's stop button: its own tests; here only that it is offered.
vi.mock('../../room-components', () => ({
  BackToLobbyButton: ({ mode }: { mode: string }) => (
    <button type="button">back-to-lobby {mode}</button>
  ),
}));

const red = hostTeamOf();

/** Every code the engine can refuse a host run command with (escape.engine.ts, escape-rules.ts). */
const HOST_REFUSALS = [
  'escape.wrong_phase',
  'escape.team_not_found',
  'escape.team_escaped',
  'escape.not_found',
  'escape.time-up',
  'escape.escaped',
  'escape.already-solved',
  'escape.unknown-lock',
];

function commandsOf(over: Partial<HostCommands> = {}): HostCommands {
  return {
    pending: {},
    hint: vi.fn(async () => 1),
    adjustTime: vi.fn(async () => ({ ok: true })),
    unlock: vi.fn(async () => ({ ok: true })),
    pause: vi.fn(async () => ({ ok: true })),
    end: vi.fn(async () => ({ ok: true })),
    ...over,
  };
}

const dialog = () => screen.getByRole('dialog');

function bar(
  commands = commandsOf(),
  over: { phase?: 'running' | 'finale'; paused?: boolean } = {},
) {
  drawEn(
    <RunBar
      pin="123456"
      socket={null}
      phase={over.phase ?? 'running'}
      paused={over.paused ?? false}
      commands={commands}
    />,
  );
  return commands;
}

describe('host actions', () => {
  afterEach(() => vi.restoreAllMocks());

  describe('give hint (team)', () => {
    it('the confirm shows the next hint and what it adds to the score, then sends it', async () => {
      const commands = commandsOf();
      drawEn(<GiveHintButton outline={outlineOf()} team={red} commands={commands} />);
      fireEvent.click(screen.getByRole('button', { name: 'Give hint' }));
      expect(dialog()).toHaveTextContent('Give Team Red the next hint?');
      expect(dialog()).toHaveTextContent('Look at the plaque.');
      expect(dialog()).toHaveTextContent('It adds 30 s to their score.');
      expect(commands.hint).not.toHaveBeenCalled();
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Give the hint' }));
      await waitFor(() => expect(commands.hint).toHaveBeenCalledWith('t1'));
    });

    it('the next hint skips the released ones', () => {
      drawEn(
        <GiveHintButton
          outline={outlineOf()}
          team={hostTeamOf({ hintIds: ['lobby-h1'] })}
          commands={commandsOf()}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Give hint' }));
      expect(dialog()).toHaveTextContent('The year is the code.');
      expect(dialog()).toHaveTextContent('It adds 60 s to their score.');
    });

    it('released: 0 says no hint is left', async () => {
      const commands = commandsOf({ hint: vi.fn(async () => 0) });
      drawEn(<GiveHintButton outline={outlineOf()} team={red} commands={commands} />);
      fireEvent.click(screen.getByRole('button', { name: 'Give hint' }));
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Give the hint' }));
      expect(await screen.findByRole('status')).toHaveTextContent('No hint left for this team.');
    });

    it('with no hint left in the outline, it says so and sends nothing', () => {
      const commands = commandsOf();
      drawEn(
        <GiveHintButton
          outline={outlineOf()}
          team={hostTeamOf({ hintIds: ['lobby-h1', 'lobby-h2'] })}
          commands={commands}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Give hint' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByRole('status')).toHaveTextContent('No hint left for this team.');
      expect(commands.hint).not.toHaveBeenCalled();
    });

    it('a refusal shows its text', async () => {
      const commands = commandsOf({
        hint: vi.fn(async () => {
          throw new Error('The game is paused.');
        }),
      });
      drawEn(<GiveHintButton outline={outlineOf()} team={red} commands={commands} />);
      fireEvent.click(screen.getByRole('button', { name: 'Give hint' }));
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Give the hint' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('The game is paused.');
    });

    it('is busy while a hint is on its way, and off for a team that escaped', () => {
      const { unmount } = drawEn(
        <GiveHintButton
          outline={outlineOf()}
          team={red}
          commands={commandsOf({ pending: { hint: true } })}
        />,
      );
      const busy = screen.getByRole('button', { name: 'Give hint' });
      expect(busy).toBeDisabled();
      expect(busy).toHaveAttribute('aria-busy', 'true');
      unmount();
      drawEn(
        <GiveHintButton
          outline={outlineOf()}
          team={hostTeamOf({ escaped: true })}
          commands={commandsOf()}
        />,
      );
      expect(screen.getByRole('button', { name: 'Give hint' })).toBeDisabled();
    });
  });

  describe('give hint (all)', () => {
    it('the confirm says every team still playing pays its penalty; the answer counts them', async () => {
      const commands = bar(commandsOf({ hint: vi.fn(async () => 3) }));
      fireEvent.click(screen.getByRole('button', { name: 'Hint to all' }));
      expect(dialog()).toHaveTextContent('Give the next hint to every team still playing?');
      expect(dialog()).toHaveTextContent("Each team pays its hint's penalty on its score.");
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Give the hint' }));
      await waitFor(() => expect(commands.hint).toHaveBeenCalledWith());
      expect(await screen.findByRole('status')).toHaveTextContent('Hint given to 3 teams');
    });
  });

  describe('time', () => {
    it('steps −1, +1, +2, +5 for all; adding sends at once, deadline only said beside', async () => {
      const commands = bar();
      const all = screen.getByRole('group', { name: 'Time for all teams' });
      const note = within(all)
        .getAllByText('Moves the deadline only; the score does not change.')
        .filter((el) => !el.closest('dialog'));
      expect(note).toHaveLength(1);
      const steps = within(all)
        .getAllByRole('button')
        .filter((b) => /for all teams$/.test(b.getAttribute('aria-label') ?? ''));
      expect(steps.map((b) => b.textContent)).toEqual(['−1:00', '+1:00', '+2:00', '+5:00']);
      fireEvent.click(within(all).getByRole('button', { name: '+2:00 for all teams' }));
      await waitFor(() => expect(commands.adjustTime).toHaveBeenCalledWith(120, undefined));
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('taking time asks first, and says the score does not change', async () => {
      const commands = commandsOf();
      drawEn(<TimeControls team={red} commands={commands} />);
      fireEvent.click(screen.getByRole('button', { name: '−1:00 for Team Red' }));
      expect(commands.adjustTime).not.toHaveBeenCalled();
      expect(dialog()).toHaveTextContent('Take time from Team Red (−1:00)?');
      expect(dialog()).toHaveTextContent('Moves the deadline only; the score does not change.');
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Take the time' }));
      await waitFor(() => expect(commands.adjustTime).toHaveBeenCalledWith(-60, 't1'));
    });

    it('a custom value in minutes; zero is not sent', async () => {
      const commands = commandsOf();
      drawEn(<TimeControls team={red} commands={commands} />);
      const input = screen.getByLabelText(/Minutes to add for Team Red/);
      expect(input.className).toMatch(/text-base/);
      const apply = screen.getByRole('button', { name: 'Apply' });
      fireEvent.change(input, { target: { value: '0' } });
      expect(apply).toBeDisabled();
      fireEvent.submit(input.closest('form')!);
      expect(commands.adjustTime).not.toHaveBeenCalled();
      fireEvent.change(input, { target: { value: '3' } });
      fireEvent.click(apply);
      await waitFor(() => expect(commands.adjustTime).toHaveBeenCalledWith(180, 't1'));
      fireEvent.change(input, { target: { value: '-4' } });
      fireEvent.click(apply);
      expect(dialog()).toHaveTextContent('Take time from Team Red (−4:00)?');
    });

    it('a refusal shows its text', async () => {
      const commands = commandsOf({
        adjustTime: vi.fn(async () => {
          throw new Error('The run is over.');
        }),
      });
      drawEn(<TimeControls commands={commands} />);
      fireEvent.click(screen.getByRole('button', { name: '+1:00 for all teams' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('The run is over.');
    });
  });

  describe('unlock', () => {
    it('confirms, says it is marked in the results, then sends', async () => {
      const commands = commandsOf();
      drawEn(
        <UnlockButton
          team={red}
          lock={{ id: 'lobby-badge', label: 'Badge reader' }}
          commands={commands}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Open Badge reader for Team Red' }));
      expect(dialog()).toHaveTextContent('Open Badge reader for Team Red?');
      expect(dialog()).toHaveTextContent('It is marked in the results as opened by the host.');
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Open the lock' }));
      await waitFor(() => expect(commands.unlock).toHaveBeenCalledWith('t1', 'lobby-badge'));
    });
  });

  describe('refusals', () => {
    it('an unlock the server refuses shows its own text, not a generic one', async () => {
      const commands = commandsOf({
        unlock: vi.fn(async () => {
          throw refusalError({ code: 'escape.time-up' });
        }),
      });
      drawEn(
        <UnlockButton
          team={red}
          lock={{ id: 'lobby-badge', label: 'Badge reader' }}
          commands={commands}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Open Badge reader for Team Red' }));
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Open the lock' }));
      // The refusal's text comes from the app's own language (errors namespace).
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(errorText('escape.time-up'));
      expect(alert).not.toHaveTextContent(errorText('error'));
    });

    it.each(HOST_REFUSALS)('%s has its own text', (code) => {
      expect(refusalError({ code }).message).not.toBe(errorText('error'));
    });
  });

  describe('pause and resume', () => {
    it('one toggle', async () => {
      const commands = bar();
      fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
      await waitFor(() => expect(commands.pause).toHaveBeenCalledWith(true));
    });

    it('resume once paused', async () => {
      const commands = bar(commandsOf(), { paused: true });
      fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
      await waitFor(() => expect(commands.pause).toHaveBeenCalledWith(false));
    });

    it('the space bar toggles, but not on a control nor with a dialog open', async () => {
      const commands = bar();
      await act(async () => {
        fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
        fireEvent.keyUp(document.body, { key: ' ', code: 'Space' });
      });
      await waitFor(() => expect(commands.pause).toHaveBeenCalledTimes(1));
      // On a button: the button's own.
      const end = screen.getByRole('button', { name: 'End the run' });
      await act(async () => {
        fireEvent.keyDown(end, { key: ' ', code: 'Space' });
        fireEvent.keyUp(end, { key: ' ', code: 'Space' });
      });
      // With a confirm open.
      fireEvent.click(end);
      await act(async () => {
        fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
        fireEvent.keyUp(document.body, { key: ' ', code: 'Space' });
      });
      expect(commands.pause).toHaveBeenCalledTimes(1);
    });
  });

  describe('end and stop', () => {
    it('End asks first, then sends escape:end', async () => {
      const commands = bar();
      fireEvent.click(screen.getByRole('button', { name: 'End the run' }));
      expect(dialog()).toHaveTextContent('End the run for every team now?');
      expect(commands.end).not.toHaveBeenCalled();
      fireEvent.click(within(dialog()).getByRole('button', { name: 'End now' }));
      await waitFor(() => expect(commands.end).toHaveBeenCalledTimes(1));
    });

    it('offers stop and back to the lobby', () => {
      bar();
      expect(screen.getByRole('button', { name: 'back-to-lobby stop' })).toBeInTheDocument();
    });
  });

  it('every button is busy while its command is pending', () => {
    bar(commandsOf({ pending: { pause: true, hint: true, time: true, end: true } }));
    for (const name of ['Pause', 'Hint to all', 'End the run', '+1:00 for all teams']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
  });

  it('in the finale, the bar hides time, hints and pause', () => {
    bar(commandsOf(), { phase: 'finale' });
    expect(screen.queryByRole('region', { name: 'Run controls' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Hint|Pause|\+1:00/ })).toBeNull();
  });

  it('team actions: a hint and time for that team; tap targets of 48 px', () => {
    drawEn(<TeamActions outline={outlineOf()} team={red} commands={commandsOf()} />);
    const region = screen.getByRole('region', { name: 'Actions for Team Red' });
    expect(within(region).getByRole('button', { name: 'Give hint' }).className).toMatch(/min-h-12/);
    expect(within(region).getByRole('button', { name: '+5:00 for Team Red' }).className).toMatch(
      /min-h-12/,
    );
  });
});
