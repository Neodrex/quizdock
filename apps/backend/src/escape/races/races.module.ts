import { Logger, Module } from '@nestjs/common';
import { SETTINGS } from '@quiz-dock/contracts';
import { settings } from '../../admin/settings/settings.service';
import { SiteClient, type SiteAccess, siteAccessOf } from '../site/site-client';
import { NoRaces } from './no-races';
import { RACE_PORT, type RacePort } from './race.port';
import { SiteRaces } from './site-races';

/**
 * The port for the Site settings: Site races when ESCAPE_SITE_URL is set (an
 * invalid URL or a blank token fails the boot), none otherwise.
 */
export function racePortFor(site: SiteAccess): RacePort {
  if (!site.url.trim()) return new NoRaces();
  const log = new Logger(SiteRaces.name);
  return new SiteRaces(new SiteClient(siteAccessOf(site.url, site.token), { log }), log);
}

/** Channel races from the Site (M8 §1.2): read once at boot. */
@Module({
  providers: [
    {
      provide: RACE_PORT,
      useFactory: (): RacePort => {
        try {
          return racePortFor({
            url: settings.get(SETTINGS.ESCAPE_SITE_URL),
            token: settings.get(SETTINGS.ESCAPE_SITE_TOKEN),
          });
        } catch (err) {
          Logger.error((err as Error).message, 'RacesModule');
          throw err;
        }
      },
    },
  ],
  exports: [RACE_PORT],
})
export class RacesModule {}
