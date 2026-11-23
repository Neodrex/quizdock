/**
 * A licence brand as every licence source must give it (M7 §1.2): the static
 * source checks it at boot, the store whenever it reads a frozen licence back.
 */
import { BUILTIN_THEMES, HEX_COLOR } from '@quiz-dock/contracts';
import { z } from 'zod';
import { envSource } from '../../admin/settings/settings.service';

/** NODE_ENV, set by the images (a deployment variable), read through the settings module. */
const inProduction = () => envSource.read('NODE_ENV') === 'production';

/** https; outside production also an http://localhost origin (the dev logos). */
const logoUrl = z.string().refine((v) => {
  try {
    const url = new URL(v);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && url.hostname === 'localhost' && !inProduction();
  } catch {
    return false;
  }
}, 'an https URL (or http://localhost outside production)');

const hex = z.string().regex(HEX_COLOR);

export const licenceBrandSchema = z.object({
  name: z.string().trim().min(1).max(80),
  logoUrl: logoUrl.nullable(),
  accent: hex,
  background: hex.nullable(),
  baseTheme: z.enum(BUILTIN_THEMES),
  intro: z.string().max(280).nullable(),
});
