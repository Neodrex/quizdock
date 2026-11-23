import { Logger, Module } from '@nestjs/common';
import { SETTINGS } from '@quiz-dock/contracts';
import { settings } from '../../admin/settings/settings.service';
import { authMode } from '../../auth/auth-mode';
import { SiteClient, type SiteAccess, siteAccessOf } from './site-client';
import { SITE_HOSTS_SOURCE, SiteHostSync, siteHostSyncEnabled } from './site-hosts';

/** The Site to ask for its hosts: under OIDC with ESCAPE_SITE_URL set, none otherwise. */
export function siteHostsSourceFor(mode: string, site: SiteAccess): SiteClient | null {
  if (!siteHostSyncEnabled(mode, site.url)) return null;
  return new SiteClient(siteAccessOf(site.url, site.token), { log: new Logger(SiteHostSync.name) });
}

/** Live's `host` role from the Site (M8 §5 item 2): read once at boot. */
@Module({
  providers: [
    {
      provide: SITE_HOSTS_SOURCE,
      useFactory: (): SiteClient | null =>
        siteHostsSourceFor(authMode(), {
          url: settings.get(SETTINGS.ESCAPE_SITE_URL),
          token: settings.get(SETTINGS.ESCAPE_SITE_TOKEN),
        }),
    },
    SiteHostSync,
  ],
  exports: [SiteHostSync],
})
export class SiteHostsModule {}
