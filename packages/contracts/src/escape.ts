import { z } from 'zod';

const id = z.string().min(1).max(64);
const text = (max: number) => z.string().max(max);

const clue = z.object({
  id,
  roleId: id.nullable(),
  kind: z.enum(['text', 'image', 'audio', 'document']),
  body: text(5000),
});
const hint = z.object({
  id,
  text: text(1000),
  penaltyS: z.number().int().min(0).max(3600),
  releaseAfterS: z.number().int().min(0).max(14_400).nullable(),
});
const base = { id, label: text(200) };
const lock = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('code'), answer: text(64) }),
  z.object({ ...base, kind: z.literal('phrase'), answers: z.array(text(200)).max(20) }),
  z.object({
    ...base,
    kind: z.literal('choice'),
    options: z.array(z.object({ id, label: text(200), image: text(500).nullable() })).max(12),
    correct: z.array(id).max(12),
  }),
  z.object({
    ...base,
    kind: z.literal('sequence'),
    items: z.array(z.object({ id, label: text(200) })).max(12),
    order: z.array(id).max(12),
  }),
  z.object({
    ...base,
    kind: z.literal('combined'),
    parts: z.array(z.object({ roleId: id, answer: text(64) })).max(5),
  }),
]);
const stage = z.object({
  id,
  title: text(200),
  intro: text(5000),
  unlockText: text(1000),
  locks: z.array(lock).max(4),
  clues: z.array(clue).max(40),
  hints: z.array(hint).max(10),
});

/**
 * An escape template's content as stored and sent to the editor. Shape and size
 * only: game rules (stage counts, role coverage, answers) are checked by the
 * backend's `validateTemplate` on publish.
 */
export const escapeTemplateContentSchema = z.object({
  title: text(120),
  intro: text(20_000),
  difficulty: z.enum(['standard', 'hard']),
  targetMinutes: z.number().int().min(1).max(600),
  mode: z.enum(['roles', 'parallel']),
  roles: z.array(z.object({ id, name: text(60), description: text(500) })).max(5),
  stages: z.array(stage).max(8),
  finale: text(5000),
});
export type EscapeTemplateContent = z.infer<typeof escapeTemplateContentSchema>;
