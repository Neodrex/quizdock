import { escapeTemplateContentSchema } from '@quiz-dock/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Body of a create or an update: the whole content, the shared schema (contracts). */
export class EscapeTemplateContentDto extends createZodDto(escapeTemplateContentSchema) {}

export const escapeTemplateListItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['draft', 'published', 'archived']),
  /** Bumped on every publish. */
  version: z.number().int(),
  updatedAt: z.string(),
});

export class EscapeTemplateListItemDto extends createZodDto(escapeTemplateListItemSchema) {}

export const escapeTemplateDetailSchema = escapeTemplateListItemSchema.extend({
  createdAt: z.string(),
  content: escapeTemplateContentSchema,
});

export class EscapeTemplateDetailDto extends createZodDto(escapeTemplateDetailSchema) {}
