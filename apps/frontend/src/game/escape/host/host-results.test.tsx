import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { refusalError } from '../../game-client';
import { drawEn } from '../test-fixtures';
import { SAMPLE_ANSWERS, finaleOf } from './host-fixtures';
import { HostResults, type ResultsCommands } from './host-results';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));
// The quiz console's back-to-lobby button: its own tests; here only that it is offered.
vi.mock('../../room-components', () => ({
  BackToLobbyButton: ({ mode }: { mode: string }) => (
    <button type="button">back-to-lobby {mode}</button>
  ),
}));

const commandsOf = (over: Partial<ResultsCommands> = {}): ResultsCommands => ({
  pending: {},
  finale: vi.fn(async () => ({ ok: true })),
  runAgain: vi.fn(async () => ({ ok: true })),
  ...over,
});

function draw(over: { closed?: boolean; commands?: ResultsCommands } = {}) {
  const commands = over.commands ?? commandsOf();
  const utils = drawEn(
    <HostResults
      finale={finaleOf()}
      closed={over.closed ?? false}
      pin="123456"
      socket={null}
      stageCount={3}
      commands={commands}
    />,
  );
  return { commands, ...utils };
}

const hostRow = (teamId: string) =>
  document.querySelector(`tr[data-team="${teamId}"]`) as HTMLElement;

describe('HostResults', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the ranking and awards the teams see', () => {
    draw();
    const ranking = screen.getByRole('list', { name: 'Ranking' });
    expect(within(ranking).getAllByRole('listitem')[0]).toHaveTextContent('Team Red');
    expect(within(ranking).getAllByRole('listitem')[0]).toHaveTextContent('32:12');
    expect(screen.getByRole('list', { name: 'Awards' })).toHaveTextContent('Fastest');
  });

  it('plus the host columns: hints (paid of total), penalty, extra time, host unlocks', () => {
    draw();
    expect(screen.getByRole('table', { name: 'What you changed' })).toBeInTheDocument();
    const red = within(hostRow('t1'));
    expect(red.getByText('2 (1 paid)')).toBeInTheDocument();
    expect(red.getByText('+1:00')).toBeInTheDocument();
    expect(red.getByText('+2:00 (score unchanged)')).toBeInTheDocument();
    expect(hostRow('t1').querySelectorAll('td')[3]).toHaveTextContent('1');
    expect(hostRow('t2').querySelectorAll('td')[2]).toHaveTextContent('—');
  });

  it('"Download CSV" saves a Blob through an a[download]', async () => {
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => {
      blobs.push(b);
      return 'blob:results';
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn();
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toMatch(/^vault-heist-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(clicked[0].href).toBe('blob:results');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:results');
    // jsdom's Blob has no text(): read its bytes, the BOM kept (exactly one).
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () =>
        resolve(new TextDecoder('utf-8', { ignoreBOM: true }).decode(reader.result as ArrayBuffer));
      reader.readAsArrayBuffer(blobs[0]);
    });
    expect(text.startsWith('\ufeff')).toBe(true);
    expect(text.startsWith('\ufeff\ufeff')).toBe(false);
    expect(text).toContain('Place;Team;Escaped;Score');
    for (const a of SAMPLE_ANSWERS) expect(text.toLowerCase()).not.toContain(a);
  });

  it('"Show the finale again" sends escape:finale', async () => {
    const { commands } = draw();
    fireEvent.click(screen.getByRole('button', { name: 'Show the finale again' }));
    await waitFor(() => expect(commands.finale).toHaveBeenCalledTimes(1));
  });

  it('"Back to lobby" is the podium button', () => {
    draw();
    expect(screen.getByRole('button', { name: 'back-to-lobby podium' })).toBeInTheDocument();
  });

  it('"Run it again" calls runAgain; busy while pending', async () => {
    const { commands, unmount } = draw();
    fireEvent.click(screen.getByRole('button', { name: 'Run it again' }));
    await waitFor(() => expect(commands.runAgain).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
    unmount();
    draw({ commands: commandsOf({ pending: { runAgain: true, finale: true } }) });
    expect(screen.getByRole('button', { name: 'Run it again' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Show the finale again' })).toBeDisabled();
  });

  it('a refused "Run it again" shows why and offers another escape room', async () => {
    draw({
      commands: commandsOf({
        runAgain: vi.fn(async () => {
          throw refusalError({ code: 'escape_template.not_found' });
        }),
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run it again' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pick another escape room' })).toHaveAttribute(
      'href',
      '/escape',
    );
  });

  it('read-only once the room closed: the CSV, "Room closed" and a link to /escape', () => {
    draw({ closed: true });
    expect(screen.getByRole('button', { name: 'Download CSV' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show the finale again' })).toBeNull();
    expect(screen.queryByRole('button', { name: /back-to-lobby/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Run it again' })).toBeNull();
    expect(screen.getByText('Room closed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pick another escape room' })).toHaveAttribute(
      'href',
      '/escape',
    );
  });

  it('shows no answer value', () => {
    const { container } = draw();
    const text = container.textContent!.toLowerCase();
    for (const a of SAMPLE_ANSWERS) expect(text).not.toContain(a);
  });
});
