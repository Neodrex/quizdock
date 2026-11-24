import { ESCAPE_SESSION_TYPES, ESCAPE_TOOLS, toolsOf } from '@quiz-dock/contracts';
import {
  GROUP_MAX_PLAYERS,
  LICENCE_USE_WINDOW_MS,
  licenceUseKey,
  RACE_MAX_PLAYERS,
  SESSION_RULES,
  capOf,
  limitsOf,
  modeAllowed,
  toolAllowed,
} from './escape-session';

describe('escape session rules (M7 §1.1)', () => {
  it('a licence use covers 12 hours; the first key is the room id, later ones are numbered', () => {
    expect(LICENCE_USE_WINDOW_MS).toBe(12 * 3_600_000);
    expect(licenceUseKey('room', 1)).toBe('room');
    expect(licenceUseKey('room', 2)).toBe('room:2');
    expect(licenceUseKey('a'.repeat(32), 12).length).toBeLessThanOrEqual(64);
  });

  it('caps: 6 for group play, 500 for a race, the licence for a hosted event', () => {
    expect(capOf('group')).toBe(6);
    expect(GROUP_MAX_PLAYERS).toBe(6);
    expect(capOf('race')).toBe(500);
    expect(RACE_MAX_PLAYERS).toBe(500);
    expect(capOf('hosted', { participantCap: 8 })).toBe(8);
    expect(capOf('hosted', { participantCap: 2000 })).toBe(2000);
  });

  it('a hosted event has no cap without its licence', () => {
    expect(() => capOf('hosted')).toThrow();
  });

  it('group play and races allow parallel templates only', () => {
    expect(modeAllowed('group', 'roles')).toBe(false);
    expect(modeAllowed('group', 'parallel')).toBe(true);
    expect(modeAllowed('race', 'roles')).toBe(false);
    expect(modeAllowed('race', 'parallel')).toBe(true);
    expect(modeAllowed('hosted', 'roles')).toBe(true);
    expect(modeAllowed('hosted', 'parallel')).toBe(true);
  });

  it('toolAllowed agrees with toolsOf for every pair', () => {
    for (const type of ESCAPE_SESSION_TYPES) {
      for (const tool of ESCAPE_TOOLS) {
        expect(toolAllowed(type, tool)).toBe(toolsOf(type).includes(tool));
      }
    }
  });

  it('only a race has payload limits', () => {
    expect(limitsOf('race')).toEqual({ boardTeams: 30, boardEveryMs: 1000, finaleTop: 20 });
    expect(limitsOf('group')).toBeNull();
    expect(limitsOf('hosted')).toBeNull();
  });

  it('only a hosted event needs a licence', () => {
    expect(SESSION_RULES.group.licence).toBe(false);
    expect(SESSION_RULES.race.licence).toBe(false);
    expect(SESSION_RULES.hosted.licence).toBe(true);
  });

  it('formation: group play at most 3 teams of up to 6, a race teams of up to 3', () => {
    expect(SESSION_RULES.group.formation).toEqual({ maxTeams: 3, maxSize: 6 });
    expect(SESSION_RULES.race.formation).toEqual({ maxTeams: null, maxSize: 3 });
    expect(SESSION_RULES.hosted.formation).toEqual({ maxTeams: null, maxSize: null });
  });
});
