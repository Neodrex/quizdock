/**
 * Live's `host` role for the Site's hosts (M8 §5 item 2), without a token claim.
 *
 * Supabase's OAuth server puts a fixed set of claims in the ID token, and
 * reading roles from the access token is deprecated (gone at quizdock 1.0). So
 * the escape module polls the Site (`POST api/live/hosts`: its admins and the
 * facilitators of a licence not yet expired) and keeps Live's sticky
 * `assignedRoles` in step, the way `qd users.set-role` grants. It owns only the
 * grants it made (`EscapeSiteHost`): an operator's grant is never taken back.
 * An account the Site lists but Live has never seen is made ahead of its first
 * sign-in, so that sign-in is a host at once; it then takes the token's name.
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { z } from 'zod';
import { canonical } from '../../auth/roles';
import { PrismaService } from '../../prisma/prisma.service';
import type { SiteClient } from './site-client';

export interface SiteHost {
  subject: string;
  name: string | null;
}

/** What Live knows of an account the sync may touch. */
export interface KnownUser {
  oidcSubject: string;
  assignedRoles: UserRole[];
  deletedAt: Date | null;
}

export interface HostSyncPlan {
  /** Accounts to make, with `host` granted and owned. */
  create: SiteHost[];
  /** Accounts to grant `host` to, and own the grant. */
  grant: string[];
  /** Owned grants the Site dropped: `host` taken back, ownership dropped. */
  revoke: string[];
  /** Owned rows with nothing left to take back (account gone, or no `host`). */
  release: string[];
}

/** How often the Site is asked (a removed facilitator loses `host` within this). */
export const SITE_HOSTS_EVERY_MS = 60_000;

/** The account name before the first sign-in, when the Site has none. */
export const UNNAMED_HOST = 'Site host';

const answer = z.object({
  hosts: z
    .array(z.object({ subject: z.string().min(1).max(255), name: z.string().max(200).nullable() }))
    .max(10_000),
});

/** The Site's hosts, or null when it cannot say (then nothing changes). */
export async function fetchSiteHosts(site: Pick<SiteClient, 'post'>): Promise<SiteHost[] | null> {
  const res = await site.post('api/live/hosts', {}, answer);
  return res.ok ? res.value.hosts : null;
}

/** The sync runs under OIDC (the Site's sign-in) with a Site to ask. */
export function siteHostSyncEnabled(authMode: string, siteUrl: string): boolean {
  return authMode === 'oidc' && siteUrl.trim() !== '';
}

/** What to change so that the owned `host` grants are exactly the Site's hosts. */
export function planHostSync(
  hosts: readonly SiteHost[],
  users: readonly KnownUser[],
  owned: readonly string[],
): HostSyncPlan {
  const bySubject = new Map(users.map((u) => [u.oidcSubject, u]));
  const listed = new Map(hosts.map((h) => [h.subject, h]));
  const plan: HostSyncPlan = { create: [], grant: [], revoke: [], release: [] };
  for (const host of listed.values()) {
    const user = bySubject.get(host.subject);
    if (!user) plan.create.push(host);
    else if (!user.deletedAt && !user.assignedRoles.includes(UserRole.host)) {
      plan.grant.push(host.subject);
    }
  }
  for (const subject of new Set(owned)) {
    if (listed.has(subject)) continue;
    const user = bySubject.get(subject);
    if (user?.assignedRoles.includes(UserRole.host)) plan.revoke.push(subject);
    else plan.release.push(subject);
  }
  return plan;
}

export const SITE_HOSTS_SOURCE = Symbol('SITE_HOSTS_SOURCE');

@Injectable()
export class SiteHostSync implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SiteHostSync.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(SITE_HOSTS_SOURCE)
    private readonly site: Pick<SiteClient, 'post'> | null = null,
  ) {}

  /** Once at start-up (so the first sign-in after a boot is already right), then every minute. */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.site) return;
    await this.syncOnce();
    this.timer = setInterval(() => void this.syncOnce(), SITE_HOSTS_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass; a pass already running is joined, not doubled. Never throws. */
  syncOnce(): Promise<void> {
    this.running ??= this.pass()
      .catch((err: unknown) =>
        this.logger.warn(`site hosts: sync failed (${(err as Error).message})`),
      )
      .finally(() => (this.running = null));
    return this.running;
  }

  private async pass(): Promise<void> {
    if (!this.site) return;
    const hosts = await fetchSiteHosts(this.site);
    if (!hosts) return; // The Site cannot say: keep every grant as it is.
    const owned = (
      await this.prisma.escapeSiteHost.findMany({ select: { oidcSubject: true } })
    ).map((r) => r.oidcSubject);
    const subjects = [...new Set([...hosts.map((h) => h.subject), ...owned])];
    const users = await this.prisma.user.findMany({
      where: { oidcSubject: { in: subjects } },
      select: { oidcSubject: true, assignedRoles: true, deletedAt: true },
    });
    const plan = planHostSync(hosts, users, owned);
    await this.apply(plan);
    const made = plan.create.length + plan.grant.length;
    if (made || plan.revoke.length) {
      this.logger.log(`site hosts: host granted to ${made}, taken back from ${plan.revoke.length}`);
    }
  }

  private async apply(plan: HostSyncPlan): Promise<void> {
    const { prisma } = this;
    await prisma.$transaction(async (tx) => {
      if (plan.create.length) {
        // A sign-in racing this pass makes the account first: skipped, granted next pass.
        await tx.user.createMany({
          data: plan.create.map((h) => ({
            oidcSubject: h.subject,
            displayName: h.name?.trim() || UNNAMED_HOST,
            email: null,
            roles: [UserRole.host],
            assignedRoles: [UserRole.host],
          })),
          skipDuplicates: true,
        });
      }
      for (const subject of plan.grant) {
        const u = await tx.user.findUnique({ where: { oidcSubject: subject } });
        if (!u) continue;
        await tx.user.update({
          where: { id: u.id },
          data: {
            assignedRoles: canonical([...u.assignedRoles, UserRole.host]),
            roles: canonical([...u.roles, UserRole.host]),
          },
        });
      }
      for (const subject of plan.revoke) {
        const u = await tx.user.findUnique({ where: { oidcSubject: subject } });
        if (!u) continue;
        const without = (roles: UserRole[]) => roles.filter((r) => r !== UserRole.host);
        await tx.user.update({
          where: { id: u.id },
          data: { assignedRoles: without(u.assignedRoles), roles: without(u.roles) },
        });
      }
      const own = [...plan.create.map((h) => h.subject), ...plan.grant];
      if (own.length) {
        await tx.escapeSiteHost.createMany({
          data: own.map((oidcSubject) => ({ oidcSubject })),
          skipDuplicates: true,
        });
      }
      const drop = [...plan.revoke, ...plan.release];
      if (drop.length) await tx.escapeSiteHost.deleteMany({ where: { oidcSubject: { in: drop } } });
    });
  }
}
