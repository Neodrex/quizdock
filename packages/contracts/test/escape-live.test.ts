import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ZodType } from 'zod';
import { GameState } from '../src';
import {
  escapeAdjustTimeSchema,
  escapeAskHintSchema,
  escapeChooseTeamSchema,
  escapeCreateSchema,
  escapeHintSchema,
  escapeMoveSchema,
  escapeOpenSchema,
  escapePauseSchema,
  escapePinSchema,
  escapeSubmitSchema,
  escapeTeamsSchema,
  escapeUnlockSchema,
  ESCAPE_TOOLS,
  toolsOf,
  type EscapeSessionType,
  type EscapeTool,
  type EscapeHostLock,
  type EscapeHostOutline,
  type EscapeHostTeam,
  type EscapePlayerState,
  type EscapeBoard,
  type EscapeScreenFinale,
  type EscapeServerToClientEvents,
} from '../src/escape-live';

const pin = '123456';
const minimal: [string, ZodType, Record<string, unknown>][] = [
  ['create', escapeCreateSchema, { templateId: 't1' }],
  ['open', escapeOpenSchema, { pin, templateId: 't1' }],
  ['pin', escapePinSchema, { pin }],
  ['teams', escapeTeamsSchema, { pin, mode: 'auto', count: 2 }],
  ['move', escapeMoveSchema, { pin, playerId: 'p1', teamId: 'a' }],
  ['pause', escapePauseSchema, { pin, paused: true }],
  ['adjust-time', escapeAdjustTimeSchema, { pin, deltaS: 60 }],
  ['hint', escapeHintSchema, { pin }],
  ['unlock', escapeUnlockSchema, { pin, teamId: 'a', lockId: 'l1' }],
  ['choose-team', escapeChooseTeamSchema, { pin, teamId: 'a' }],
  ['submit', escapeSubmitSchema, { pin, lockId: 'l1', input: '1234' }],
  ['ask-hint', escapeAskHintSchema, { pin, hintId: 'h1' }],
];

describe('escape live schemas', () => {
  it.each(minimal)('%s accepts a minimal payload and strips unknown fields', (_, schema, p) => {
    expect(schema.parse({ ...p, extra: 'x' })).toEqual(p);
  });

  it.each(minimal.filter(([name]) => name !== 'create'))('%s wants a six-digit pin', (_, s, p) => {
    for (const bad of ['12345', '1234567', 'abcdef', 123456]) {
      expect(s.safeParse({ ...p, pin: bad }).success).toBe(false);
    }
  });

  it('refuses a zero, too large or fractional deltaS', () => {
    for (const deltaS of [0, 3601, -3601, 1.5]) {
      expect(escapeAdjustTimeSchema.safeParse({ pin, deltaS }).success).toBe(false);
    }
    expect(escapeAdjustTimeSchema.safeParse({ pin, deltaS: -3600, teamId: 'a' }).success).toBe(
      true,
    );
  });

  it('input is a string of up to 200 characters or up to 12 ids', () => {
    const ok = (input: unknown) =>
      escapeSubmitSchema.safeParse({ pin, lockId: 'l1', input }).success;
    expect(ok('x'.repeat(200))).toBe(true);
    expect(ok('x'.repeat(201))).toBe(false);
    expect(ok(Array.from({ length: 12 }, (_, i) => `i${i}`))).toBe(true);
    expect(ok(Array.from({ length: 13 }, (_, i) => `i${i}`))).toBe(false);
    expect(ok({ a: 1 })).toBe(false);
  });

  it('teamId null moves to unassigned, but is no team to choose', () => {
    expect(escapeMoveSchema.safeParse({ pin, playerId: 'p1', teamId: null }).success).toBe(true);
    expect(escapeChooseTeamSchema.safeParse({ pin, teamId: null }).success).toBe(false);
  });

  it('a hint names the expected hint only for one team', () => {
    expect(escapeHintSchema.safeParse({ pin, teamId: 'a', hintId: 'h1' }).success).toBe(true);
    expect(escapeHintSchema.safeParse({ pin, hintId: 'h1' }).success).toBe(false);
  });

  it('refuses zero teams', () => {
    expect(escapeTeamsSchema.safeParse({ pin, mode: 'self', count: 0 }).success).toBe(false);
  });
});

describe('session types (M7 §1.1)', () => {
  const create = (extra: Record<string, unknown>) =>
    escapeCreateSchema.safeParse({ templateId: 't1', ...extra });

  it('a create with no session type still parses (legacy: hosted)', () => {
    const r = create({});
    expect(r.success).toBe(true);
    expect(r.data?.sessionType).toBeUndefined();
  });

  it('a race needs its race data, and only a race takes it', () => {
    expect(create({ sessionType: 'race' }).success).toBe(false);
    expect(create({ sessionType: 'race', race: { format: 'solo' } }).success).toBe(true);
    expect(
      create({ sessionType: 'race', race: { format: 'teams', startsAt: 1_900_000_000_000 } })
        .success,
    ).toBe(true);
    expect(create({ sessionType: 'group', race: { format: 'solo' } }).success).toBe(false);
    expect(create({ sessionType: 'hosted', race: { format: 'solo' } }).success).toBe(false);
    expect(create({ race: { format: 'solo' } }).success).toBe(false);
    expect(create({ sessionType: 'race', race: { format: 'pairs' } }).success).toBe(false);
  });

  it('escape:open takes an optional licence id', () => {
    expect(escapeOpenSchema.safeParse({ pin, templateId: 't1', licenceId: 'acme' }).success).toBe(
      true,
    );
    expect(escapeOpenSchema.safeParse({ pin, templateId: 't1', licenceId: '' }).success).toBe(
      false,
    );
  });

  it('takes a licence id and refuses an unknown type', () => {
    expect(create({ sessionType: 'hosted', licenceId: 'lic-1' }).success).toBe(true);
    expect(create({ sessionType: 'party' }).success).toBe(false);
    expect(create({ licenceId: '' }).success).toBe(false);
  });

  // §1.1, row by row: [tool, group, race, hosted].
  const table: [EscapeTool, boolean, boolean, boolean][] = [
    ['teams', true, false, true],
    ['move', true, false, true],
    ['start', true, true, true],
    ['pause', true, true, true],
    ['adjust-all', true, true, true],
    ['adjust-team', true, false, true],
    ['hint-team', true, false, true],
    ['hint-all', true, true, true],
    ['unlock', false, false, true],
    ['end', true, true, true],
    ['finale', true, true, true],
    ['csv', false, true, true],
  ];

  it('the table names every tool once', () => {
    expect(table.map(([t]) => t).sort()).toEqual([...ESCAPE_TOOLS].sort());
  });

  it.each(table)('%s: group %s, race %s, hosted %s', (tool, group, race, hosted) => {
    const has = (type: EscapeSessionType) => toolsOf(type).includes(tool);
    expect([has('group'), has('race'), has('hosted')]).toEqual([group, race, hosted]);
  });
});

describe('GameState', () => {
  it('has an escape state', () => {
    expect(GameState.Escape).toBe('ESCAPE');
  });
});

describe('EscapePlayerState', () => {
  it("gives the team's run time at its escape, or null", () => {
    expectTypeOf<NonNullable<EscapePlayerState['team']>['escapedMs']>().toEqualTypeOf<
      number | null
    >();
  });
});

describe('EscapeHostOutline (M5 owner question 1)', () => {
  it('is what escape:outline carries', () => {
    expectTypeOf<
      Parameters<EscapeServerToClientEvents['escape:outline']>[0]
    >().toEqualTypeOf<EscapeHostOutline>();
  });

  it('gives a lock no answer field', () => {
    expectTypeOf<keyof EscapeHostLock>().toEqualTypeOf<
      'id' | 'label' | 'kind' | 'partRoles' | 'options' | 'items'
    >();
  });
});

describe('EscapeHostTeam', () => {
  it('tells the paid hints from the free ones, so a reload still shows the cost', () => {
    expectTypeOf<EscapeHostTeam['paidHintIds']>().toEqualTypeOf<string[]>();
  });
});

describe('EscapeScreenFinale (M6 §1.4)', () => {
  it('is what escape:screen-finale carries', () => {
    expectTypeOf<
      Parameters<EscapeServerToClientEvents['escape:screen-finale']>[0]
    >().toEqualTypeOf<EscapeScreenFinale>();
  });

  it('has no host column and no player id', () => {
    expectTypeOf<keyof EscapeScreenFinale['ranking'][number]>().toEqualTypeOf<
      | 'teamId'
      | 'name'
      | 'place'
      | 'scoreMs'
      | 'escaped'
      | 'timedOut'
      | 'stagesCleared'
      | 'stageClearedAt'
      | 'hintsUsed'
      | 'hintPenaltyS'
      | 'members'
    >();
    expectTypeOf<EscapeScreenFinale['ranking'][number]['members']>().toEqualTypeOf<string[]>();
  });
});

describe('EscapeBoard (M6 Task 6.2)', () => {
  it('says the run and how teams form', () => {
    expectTypeOf<EscapeBoard['gameId']>().toEqualTypeOf<string>();
    expectTypeOf<EscapeBoard['formation']>().toEqualTypeOf<{
      mode: 'auto' | 'self';
      maxSize: number | null;
    }>();
  });

  it('gives the roster nicknames only: no player id, avatar or role', () => {
    expectTypeOf<keyof EscapeBoard['roster'][number]>().toEqualTypeOf<
      'teamId' | 'nickname' | 'connected'
    >();
  });
});
