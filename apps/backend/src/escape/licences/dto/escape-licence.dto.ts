import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * A licence the host may run a hosted event under, for the create dialog
 * (M7 Task 7.12). The host's own list: the id to pick by and what remains.
 * Never the organisation id, the hosts or the brand's details.
 */
export const escapeLicenceSummarySchema = z.object({
  id: z.string(),
  /** The brand's name; null: a licence without a brand. */
  organisationName: z.string().nullable(),
  package: z.enum(['single', 'bundle', 'annual']),
  participantCap: z.number().int(),
  /** ms epoch. */
  expiresAt: z.number().int(),
  /** null: annual. */
  eventsLeft: z.number().int().nullable(),
  hasBrand: z.boolean(),
});

export class EscapeLicenceSummaryDto extends createZodDto(escapeLicenceSummarySchema) {}
