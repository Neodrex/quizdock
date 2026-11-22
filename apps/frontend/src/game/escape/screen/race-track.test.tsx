import type { EscapeBoard, EscapeTeamSummary } from '@quiz-dock/contracts';
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MotionLevel } from '../../motion/level';
import { drawEn } from '../test-fixtures';
import { RaceTrack } from './race-track';
import { laneScaleOf } from './screen-layout';
import { boardOf, summaryOf } from './screen-fixtures';

const motion = vi.hoisted(() => ({ level: 'full' as MotionLevel }));
vi.mock('../../motion/level', () => ({ useMotionLevel: () => motion.level }));

const NOW = 1_000_000_000;
const MIN = 60_000;

const red = summaryOf({ stageIndex: 1, stageTitle: 'The Office', locksSolved: 1, hintsUsed: 2 });
const blue = summaryOf({ id: 't2', name: 'Team Blue', stageIndex: 0, hintsUsed: 0 });
const green = summaryOf({ id: 't3', name: 'Team Green', stageIndex: 2, stageTitle: '' });

const draw = (teams: EscapeTeamSummary[], over: Partial<EscapeBoard> = {}) =>
  drawEn(<RaceTrack board={boardOf({ teams, ...over })} now={NOW} />);

const lane = (name: string) =>
  screen.getByText(name, { selector: '[data-lane] span' }).closest('li')!;
const lanes = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('li[data-lane]')];
const nameOf = (li: Element) => li.querySelector('[data-lane-name]')?.textContent;
/** The text a screen reader reads: aria-hidden subtrees left out. */
const spoken = (el: Element) => {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
  return copy.textContent?.replace(/\s+/g, ' ').trim() ?? '';
};
const badge = (li: Element) => li.querySelector<HTMLElement>('[data-place]')!;

beforeEach(() => {
  motion.level = 'full';
});

describe('RaceTrack', () => {
  it('draws one lane per team in team order, each with its place', () => {
    draw([red, blue, green]);
    const all = lanes(screen.getByRole('list', { name: 'Race' }));
    expect(all.map(nameOf)).toEqual(['Team Red', 'Team Blue', 'Team Green']);
    expect(all.some((li) => li.hasAttribute('aria-label'))).toBe(false);
    const first = badge(lane('Team Green'));
    expect(spoken(first)).toBe('Place 1');
    expect(within(first).getByText('#1')).toHaveAttribute('aria-hidden', 'true');
    expect(spoken(badge(lane('Team Red')))).toBe('Place 2');
    expect(spoken(badge(lane('Team Blue')))).toBe('Place 3');
  });

  it('shows one segment per stage: done, current with its locks, ahead', () => {
    draw([red]);
    const segs = within(lane('Team Red')).getAllByTestId('stage-segment');
    expect(segs.map((s) => s.dataset.state)).toEqual(['done', 'current', 'ahead']);
    expect(segs[1]).toHaveTextContent('1/2');
    expect(within(lane('Team Red')).getByText('The Office')).toBeInTheDocument();
    expect(within(lane('Team Red')).getByText('2 hints')).toBeInTheDocument();
  });

  it('leaves out an unknown stage title and a zero hint count', () => {
    draw([green, blue]);
    expect(within(lane('Team Blue')).queryByText(/hint/)).toBeNull();
    expect(within(lane('Team Green')).queryByText('The Lobby')).toBeNull();
  });

  it("shows a lane's own time only when it differs from the show clock", () => {
    draw([red, { ...blue, remainingMs: 42 * MIN, deadlineAt: NOW + 42 * MIN }]);
    expect(within(lane('Team Red')).getByText('40:00')).toBeInTheDocument();
    expect(within(lane('Team Blue')).queryByText('42:00')).toBeNull();
  });

  it('marks an escaped lane with its time, and greys a timed-out one', () => {
    draw([
      { ...red, escaped: true, escapedAtMs: 31 * MIN + 12_000, stageIndex: 3 },
      { ...blue, timedOut: true },
    ]);
    const r = lane('Team Red');
    expect(within(r).getByText('Escaped 31:12')).toBeInTheDocument();
    expect(
      within(r)
        .getAllByTestId('stage-segment')
        .map((s) => s.dataset.state),
    ).toEqual(['done', 'done', 'done']);
    expect(spoken(badge(r))).toBe('Place 1');
    const b = lane('Team Blue');
    expect(within(b).getByText('Time up')).toBeInTheDocument();
    expect(b).toHaveAttribute('data-out', 'true');
  });

  it('gives every lane the same meta width, so the stages line up whatever it shows', () => {
    // Red: 2 hints and its own time; Blue: nothing. Sized by content, Blue's segments
    // were wider than Red's and the stages did not line up across lanes.
    const fill = (n: number) =>
      Array.from({ length: n }, (_, i) => summaryOf({ id: `x${i}`, name: `X${i}` }));
    const { unmount } = draw([
      red,
      { ...blue, remainingMs: 42 * MIN, deadlineAt: NOW + 42 * MIN },
      ...fill(3),
    ]);
    const widths = (root: HTMLElement) =>
      lanes(root).map((li) => li.querySelector<HTMLElement>('[data-lane-meta]')!.className);
    const wide = widths(document.body);
    expect(wide[0]).toMatch(/\bw-\[\d+(\.\d+)?em\]/);
    expect(new Set(wide).size).toBe(1);
    unmount();
    draw(
      Array.from({ length: 20 }, (_, i) =>
        summaryOf({ id: `t${i}`, name: `T${i}`, hintsUsed: i % 2 }),
      ),
    );
    const dense = widths(document.body);
    expect(dense[0]).toMatch(/\bw-\[\d+(\.\d+)?em\]/);
    expect(new Set(dense).size).toBe(1);
  });

  it('a small race fills the screen: lanes scaled up, the stages on a row of their own', () => {
    // The stages line up there by their own full-width row, whatever the meta shows.
    const teams = (n: number) =>
      Array.from({ length: n }, (_, i) => summaryOf({ id: `t${i}`, name: `Team ${i}` }));
    const { unmount } = draw(teams(2));
    const two = screen.getByRole('list', { name: 'Race' });
    expect(two).toHaveAttribute('data-tall', 'true');
    expect(two.style.fontSize).toBe(`${laneScaleOf(2)}em`);
    expect(laneScaleOf(2)).toBeGreaterThan(1);
    for (const li of lanes(two)) expect(li).toHaveAttribute('data-stacked', 'true');
    unmount();
    draw(teams(5));
    const five = screen.getByRole('list', { name: 'Race' });
    expect(five).not.toHaveAttribute('data-tall');
    expect(five.style.fontSize).toBe('');
  });

  it('marks a lane with nobody connected as offline', () => {
    draw([{ ...red, connectedCount: 0 }, blue]);
    expect(within(lane('Team Red')).getByText('Offline')).toBeInTheDocument();
    expect(within(lane('Team Blue')).queryByText('Offline')).toBeNull();
  });

  it('one wide column up to 5 teams, then up to 4 compact ones of 8 rows to 30', () => {
    const teams = (n: number) =>
      Array.from({ length: n }, (_, i) => summaryOf({ id: `t${i}`, name: `Team ${i}` }));
    const { unmount } = draw(teams(5));
    expect(screen.getByRole('list', { name: 'Race' })).toHaveClass('grid-cols-1');
    expect(screen.getAllByText('The Lobby')).toHaveLength(5);
    unmount();
    const again = draw(teams(12));
    const twelve = screen.getByRole('list', { name: 'Race' });
    expect(twelve).toHaveClass('grid-cols-2');
    expect(twelve).toHaveAttribute('data-compact', 'true');
    // One line per lane: the stage title is left out.
    expect(screen.queryByText('The Lobby')).toBeNull();
    again.unmount();
    draw(teams(30));
    const track = screen.getByRole('list', { name: 'Race' });
    expect(track).toHaveClass('grid-cols-4');
    expect(lanes(track)).toHaveLength(30);
  });

  it('above 30 teams shows the top 12 by place and counts the rest', () => {
    const teams = Array.from({ length: 42 }, (_, i) =>
      summaryOf({ id: `t${i}`, name: `Team ${i}`, stageIndex: i < 12 ? 2 : 0 }),
    );
    draw(teams);
    const track = screen.getByRole('list', { name: 'Race' });
    const shown = lanes(track);
    expect(shown).toHaveLength(12);
    expect(shown.map(nameOf)).toEqual(Array.from({ length: 12 }, (_, i) => `Team ${i}`));
    expect(screen.getByText('and 30 more teams')).toBeInTheDocument();
    expect(screen.getByText('Stage 1: 30 teams')).toBeInTheDocument();
  });

  it.each([
    ['full', true],
    ['fade', false],
    ['none', false],
  ] as const)('motion %s animates the segment fills: %s', (level, animated) => {
    motion.level = level;
    draw([red]);
    const fill = within(lane('Team Red')).getAllByTestId('stage-fill')[1];
    expect(fill.className.includes('transition-')).toBe(animated);
  });
});
