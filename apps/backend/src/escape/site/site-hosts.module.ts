import { Logger, Module } from '@nestjs/common';
import { SETTINGS } from '@quiz-dock/contracts';
import { settings } from '../../admin/settings/settings.service';
import { authMode } from '../../auth/auth-mode';
import { SiteClient, type SiteAccess, siteAccessOf } from './site-client';
import {
  SITE_HOSTS_SOURCE,
  SITE_HOSTS_STATE,
  SiteHostSync,
  SiteStateLog,
  siteHostSyncEnabled,
} from './site-hosts';

/**
 * The Site to ask for its hosts: under OIDC with ESCAPE_SITE_URL set, none
 * otherwise. Its failures are logged through `state`: once while the Site is down.
 */
export function siteHostsSourceFor(
  mode: string,
  site: SiteAccess,
  state: SiteStateLog = new SiteStateLog(new Logger(SiteHostSync.name)),
): SiteClient | null {
  if (!siteHostSyncEnabled(mode, site.url)) return null;
  return new SiteClient(siteAccessOf(site.url, site.token), { log: state });
}

/** Live's `host` role from the Site (M8 §5 item 2): read once at boot. */
@Module({
  providers: [
    {
      provide: SITE_HOSTS_STATE,
      useFactory: () => new SiteStateLog(new Logger(SiteHostSync.name)),
    },
    {
      provide: SITE_HOSTS_SOURCE,
      inject: [SITE_HOSTS_STATE],
      useFactory: (state: SiteStateLog): SiteClient | null =>
        siteHostsSourceFor(
          authMode(),
          {
            url: settings.get(SETTINGS.ESCAPE_SITE_URL),
            token: settings.get(SETTINGS.ESCAPE_SITE_TOKEN),
          },
          state,
        ),
    },
    SiteHostSync,
  ],
  exports: [SiteHostSync],
})
export class SiteHostsModule {}
