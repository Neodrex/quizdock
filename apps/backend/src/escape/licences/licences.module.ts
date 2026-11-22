import { Logger, Module } from '@nestjs/common';
import { SETTINGS } from '@quiz-dock/contracts';
import { settings } from '../../admin/settings/settings.service';
import { LICENCE_PORT, type LicencePort } from './licence.port';
import { NoLicences } from './no-licences';
import { StaticLicences, parseStaticLicences } from './static-licences';

/** The port for a source (ESCAPE_LICENCE_SOURCE). M8 adds `site`. */
export function licencePortFor(source: 'none' | 'static', raw: string): LicencePort {
  if (source === 'static') return new StaticLicences(parseStaticLicences(raw));
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
