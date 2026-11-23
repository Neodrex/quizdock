import { Logger, Module } from '@nestjs/common';
import { SETTINGS } from '@quiz-dock/contracts';
import { settings } from '../../admin/settings/settings.service';
import { LICENCE_PORT, type LicencePort } from './licence.port';
import { NoLicences } from './no-licences';
import { StaticLicences, parseStaticLicences } from './static-licences';

/** Where the Site source reaches the Site (ESCAPE_SITE_URL, ESCAPE_SITE_TOKEN). */
export interface SiteAccess {
  url: string;
  token: string;
}

/** The port for a source (ESCAPE_LICENCE_SOURCE). */
export function licencePortFor(
  source: 'none' | 'static' | 'site',
  raw: string,
  site: SiteAccess = { url: '', token: '' },
): LicencePort {
  if (source === 'static') return new StaticLicences(parseStaticLicences(raw));
  if (source === 'site') {
    // A token under 32 characters is unreadable, so it arrives here empty.
    if (!site.url.trim() || !site.token) {
      throw new Error(
        'ESCAPE_LICENCE_SOURCE=site needs ESCAPE_SITE_URL and ESCAPE_SITE_TOKEN (32 characters or more).',
      );
    }
    throw new Error('SiteLicences: Task 8.13 (the Site source is not built yet).');
  }
  return new NoLicences();
}

/** Who owns the licences (M7 §1.2): read once at boot, an invalid value fails it. */
@Module({
  providers: [
    {
      provide: LICENCE_PORT,
      useFactory: (): LicencePort => {
        try {
          return licencePortFor(
            settings.get(SETTINGS.ESCAPE_LICENCE_SOURCE),
            settings.get(SETTINGS.ESCAPE_STATIC_LICENCES),
            {
              url: settings.get(SETTINGS.ESCAPE_SITE_URL),
              token: settings.get(SETTINGS.ESCAPE_SITE_TOKEN),
            },
          );
        } catch (err) {
          Logger.error((err as Error).message, 'LicencesModule');
          throw err;
        }
      },
    },
  ],
  exports: [LICENCE_PORT],
})
export class LicencesModule {}
