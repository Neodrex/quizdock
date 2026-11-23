import type { Logger } from '@nestjs/common';
import { z } from 'zod';
import { licenceBrandSchema } from '../licences/brand-schema';
import type { LicenceBrand } from '../licences/licence.port';

const isHttps = (v: string) => {
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * A brand as the Site sends it (a licence's or a race channel's), checked by
 * licenceBrandSchema. The Site sends a logo only when it is https; anything
 * else is dropped here too, with a warning, and the brand stays usable.
 */
export function siteBrandSchema(log: Pick<Logger, 'warn'>): z.ZodType<LicenceBrand> {
  return z
    .object({ logoUrl: z.string().nullable() })
    .passthrough()
    .transform((b) => {
      if (b.logoUrl !== null && !isHttps(b.logoUrl)) {
        log.warn('site brand: a logo that is not https was dropped');
        return { ...b, logoUrl: null };
      }
      return b;
    })
    .pipe(licenceBrandSchema) as unknown as z.ZodType<LicenceBrand>;
}
