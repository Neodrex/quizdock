import { escapeTemplateContentSchema } from '@quiz-dock/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Body of a create or an update: the whole content, the shared schema (contracts). */
export class EscapeTemplateContentDto extends createZodDto(escapeTemplateContentSchema) {}

/** The row's own fields, shared by the list and the detail. */
const templateRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['draft', 'published', 'archived']),
  /** Bumped on every publish. */
  version: z.number().int(),
  updatedAt: z.string(),
});

/** A list item: the row and what the picker shows, no content. */
export const escapeTemplateListItemSchema = templateRowSchema.extend({
  mode: z.enum(['roles', 'parallel']),
  difficulty: z.enum(['standard', 'hard']),
  targetMinutes: z.number().int(),
  stageCount: z.number().int(),
});

export class EscapeTemplateListItemDto extends createZodDto(escapeTemplateListItemSchema) {}

export const escapeTemplateDetailSchema = templateRowSchema.extend({
  createdAt: z.string(),
  content: escapeTemplateContentSchema,
});

export class EscapeTemplateDetailDto extends createZodDto(escapeTemplateDetailSchema) {}
