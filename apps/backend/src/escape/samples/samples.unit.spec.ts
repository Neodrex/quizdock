import { type EscapeTemplateContent, escapeTemplateContentSchema } from '@quiz-dock/contracts';
import { newTeam, submit } from '../escape-rules';
import { validateTemplate } from '../escape-template';
import type { EscapeTemplate, Lock, LockInput, SubmitResult } from '../escape.types';
import { SAMPLES } from './index';

/** The input that opens a non-combined lock. */
function answerOf(lock: Exclude<Lock, { kind: 'combined' }>): LockInput {
  switch (lock.kind) {
    case 'code':
      return lock.answer;
    case 'phrase':
      return lock.answers[0];
    case 'choice':
      return lock.correct;
    case 'sequence':
      return lock.order;
  }
}

describe.each(SAMPLES.map((s) => [s.title, s] as [string, EscapeTemplateContent]))(
  'sample "%s"',
  (_title, content) => {
    const tpl: EscapeTemplate = { id: 'sample', ...content };

    it('fits the schema and has no problems', () => {
      expect(escapeTemplateContentSchema.parse(content)).toEqual(content);
      expect(validateTemplate(tpl)).toEqual([]);
    });

    it('can be played to escaped with its own answers', () => {
      const members = Array.from({ length: Math.max(tpl.roles.length, 1) }, (_, i) => `p${i}`);
      let team = newTeam(tpl, 'team', 'Team', members);
      let last: SubmitResult | undefined;
      let at = 0;
      for (const [index, stage] of tpl.stages.entries()) {
        expect(team.stageIndex).toBe(index);
        for (const lock of stage.locks) {
          if (lock.kind === 'combined') {
            for (const part of lock.parts) {
              const holder = members.find((m) => team.roles[m]?.includes(part.roleId));
              expect(holder).toBeDefined();
              ({ team, result: last } = submit(
                tpl,
                team,
                { playerId: holder!, lockId: lock.id, roleId: part.roleId, input: part.answer },
                (at += 1000),
              ));
              expect(['part-accepted', 'lock-solved', 'stage-cleared', 'escaped']).toContain(
                last.outcome,
              );
            }
          } else {
            ({ team, result: last } = submit(
              tpl,
              team,
              { playerId: members[0], lockId: lock.id, input: answerOf(lock) },
              (at += 1000),
            ));
            expect(['lock-solved', 'stage-cleared', 'escaped']).toContain(last.outcome);
          }
        }
      }
      expect(last).toEqual({ outcome: 'escaped' });
      expect(team.escapedAt).not.toBeNull();
      expect(team.wrong).toBe(0);
    });

    it("puts each combined part's answer only in clues for that role", () => {
      for (const stage of tpl.stages) {
        for (const lock of stage.locks) {
          if (lock.kind !== 'combined') continue;
          for (const part of lock.parts) {
            const answer = part.answer.toLowerCase();
            const has = (text: string) => text.toLowerCase().includes(answer);
            const carriers = tpl.stages.flatMap((s) => s.clues).filter((c) => has(c.body));
            expect(carriers.length).toBeGreaterThan(0);
            expect(carriers.every((c) => c.roleId === part.roleId)).toBe(true);
            expect(tpl.stages.flatMap((s) => s.hints).some((h) => has(h.text))).toBe(false);
          }
        }
      }
    });
  },
);

describe('samples', () => {
  it('Vault Heist uses roles and every lock kind; Lost Library is parallel, no roles', () => {
    const [vault, library] = SAMPLES;
    expect(vault).toMatchObject({ title: 'Vault Heist', mode: 'roles' });
    expect(vault.roles).toHaveLength(3);
    expect(vault.stages).toHaveLength(4);
    const kinds = new Set(vault.stages.flatMap((s) => s.locks.map((l) => l.kind)));
    expect([...kinds].sort()).toEqual(['choice', 'code', 'combined', 'phrase', 'sequence']);
    const clues = vault.stages.flatMap((s) => s.clues);
    expect(clues.some((c) => c.roleId === null)).toBe(true);
    expect(clues.some((c) => c.roleId !== null)).toBe(true);
    expect(vault.stages.every((s) => s.hints.length === 2)).toBe(true);

    expect(library).toMatchObject({ title: 'Lost Library', mode: 'parallel', roles: [] });
    expect(library.stages).toHaveLength(3);
    expect(library.stages.every((s) => s.locks.length >= 2 && s.locks.length <= 3)).toBe(true);
    expect(library.stages.flatMap((s) => s.clues).every((c) => c.roleId === null)).toBe(true);
  });
});
