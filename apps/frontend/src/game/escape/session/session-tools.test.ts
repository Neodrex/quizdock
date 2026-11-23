import { ESCAPE_TOOLS, toolsOf } from '@quiz-dock/contracts';
import { describe, expect, it } from 'vitest';
import { can, maxTeamsFor, seatsOf, toolsFor } from './session-tools';

describe('session tools', () => {
  it('a room without a session is hosted: every tool', () => {
    expect([...toolsFor(null)]).toEqual([...ESCAPE_TOOLS]);
    expect(can(undefined, 'unlock')).toBe(true);
  });

  it('follows the server’s list, else the shared table', () => {
    const group = toolsFor({ type: 'group', tools: [...toolsOf('group')] });
    expect(can(group, 'unlock')).toBe(false);
    expect(can(group, 'csv')).toBe(false);
    expect(can(group, 'hint-team')).toBe(true);
    const race = toolsFor({ type: 'race', tools: [] });
    for (const tool of ['teams', 'move', 'adjust-team', 'hint-team', 'unlock'] as const) {
      expect(can(race, tool)).toBe(false);
    }
    expect(can(race, 'csv')).toBe(true);
    expect(can(toolsFor({ type: 'hosted', tools: ['start'] }), 'end')).toBe(false);
  });

  it('group play forms at most 3 teams', () => {
    expect(maxTeamsFor({ type: 'group' })).toBe(3);
    expect(maxTeamsFor({ type: 'hosted' })).toBeUndefined();
    expect(maxTeamsFor(null)).toBeUndefined();
  });

  it('full at the cap', () => {
    expect(seatsOf({ joined: 6, cap: 6 })).toEqual({ joined: 6, cap: 6, full: true });
    expect(seatsOf({ joined: 5, cap: 6 }).full).toBe(false);
  });
});
