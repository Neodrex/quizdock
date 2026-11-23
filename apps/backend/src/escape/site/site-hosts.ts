/**
 * Live's `host` role for the Site's hosts (M8 §5 item 2), without a token claim.
 *
 * Supabase's OAuth server puts a fixed set of claims in the ID token, and
 * reading roles from the access token is deprecated (gone at quizdock 1.0). So
 * the escape module polls the Site (`POST api/live/hosts`: its admins and the
 * facilitators of a licence not yet expired) and keeps Live's sticky
 * `assignedRoles` in step, the way `qd users.set-role` grants.
 *
 * It takes back only the grants it owns (`EscapeSiteHost`), and an owned user's
 * `host` goes even if an operator ran `qd users.set-role host` on them later. So
 * a Site host cannot be demoted from Live, only on the Site; to keep `host` after
 * the Site drops a synced user, grant it with `set-role` and delete their
 * `escape_site_hosts` row. A grant an operator made before the sync saw the user
 * is never owned. A CLI change racing a pass can be lost; the next pass heals it.
 *
 * An account the Site lists but Live has never seen is made ahead of its first
 * sign-in, so that sign-in is a host at once; it then takes the token's name. If
 * the Site drops it before any sign-in, the account is deleted.
 *
 * A pass that would take back every owned grant on an empty list, or more than
 * half of them (3 or more), is refused with a warning: a Site bug must not demote
 * everyone. Apply a real mass removal by deleting the rows by hand.
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
  /** Null until a sign-in: the provider's tokens carry the address. */
  email: string | null;
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
  /** Accounts the sync made that the Site dropped before any sign-in: deleted. */
  remove: string[];
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
/** The share of owned grants one pass may take back once it is 3 or more. */
export const MAX_TAKE_BACK_SHARE = 0.5;

/**
 * Why this pass must not run (a Site answering nobody, or most hosts gone at
 * once, looks like a Site bug), or null to go ahead.
 */
export function refuseHostSync(
  hosts: readonly SiteHost[],
  owned: readonly string[],
  plan: HostSyncPlan,
): string | null {
  const total = new Set(owned).size;
  if (!total) return null;
  if (!hosts.length) {
    return `the Site lists no hosts while ${total} grants are owned`;
  }
  const back = plan.revoke.length + plan.remove.length;
  if (back >= 3 && back > total * MAX_TAKE_BACK_SHARE) {
    return `the Site would take back ${back} of ${total} owned grants`;
  }
  return null;
}

/**
 * The Site client's warnings for the host sync, said once per change of state:
 * the first failure, then that the Site answers again (not every minute).
 */
export class SiteStateLog {
  private down = false;

  constructor(private readonly logger: Pick<Logger, 'warn' | 'log'>) {}

  warn(message: string): void {
    if (this.down) return;
    this.down = true;
    this.logger.warn(`${message}; host grants kept until it answers (said once)`);
  }

  /** The Site answered. */
  up(): void {
    if (!this.down) return;
    this.down = false;
    this.logger.log('site hosts: the Site answers again');
  }
}

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
  created: ReadonlySet<string> = new Set(),
): HostSyncPlan {
  const bySubject = new Map(users.map((u) => [u.oidcSubject, u]));
  const listed = new Map(hosts.map((h) => [h.subject, h]));
  const plan: HostSyncPlan = { create: [], grant: [], revoke: [], release: [], remove: [] };
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
    if (user && !user.deletedAt && created.has(subject) && user.email === null) {
      plan.remove.push(subject);
    } else if (user?.assignedRoles.includes(UserRole.host)) plan.revoke.push(subject);
    else plan.release.push(subject);
  }
  return plan;
}

export const SITE_HOSTS_SOURCE = Symbol('SITE_HOSTS_SOURCE');
/** The `SiteStateLog` the source client warns through, told when the Site answers. */
export const SITE_HOSTS_STATE = Symbol('SITE_HOSTS_STATE');

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
    @Optional()
    @Inject(SITE_HOSTS_STATE)
    private readonly state: Pick<SiteStateLog, 'up'> | null = null,
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
    this.state?.up();
    const rows = await this.prisma.escapeSiteHost.findMany({
      select: { oidcSubject: true, created: true },
    });
    const owned = rows.map((r) => r.oidcSubject);
    const created = new Set(rows.filter((r) => r.created).map((r) => r.oidcSubject));
    const subjects = [...new Set([...hosts.map((h) => h.subject), ...owned])];
    const users = await this.prisma.user.findMany({
      where: { oidcSubject: { in: subjects } },
      select: { oidcSubject: true, assignedRoles: true, deletedAt: true, email: true },
    });
    const plan = planHostSync(hosts, users, owned, created);
    const refused = refuseHostSync(hosts, owned, plan);
    if (refused) {
      this.logger.warn(`site hosts: pass skipped, ${refused}; nothing changed`);
      return;
    }
    const removed = await this.apply(plan);
    const made = plan.create.length + plan.grant.length;
    const back = plan.revoke.length + plan.remove.length;
    if (made || back) {
      this.logger.log(
        `site hosts: host granted to ${made}, taken back from ${back} (${removed} unused accounts deleted)`,
      );
    }
  }

  /** Applies the plan in one transaction; gives the number of accounts deleted. */
  private async apply(plan: HostSyncPlan): Promise<number> {
    const { prisma } = this;
    return prisma.$transaction(async (tx) => {
      let made: string[] = [];
      if (plan.create.length) {
        // A sign-in racing this pass makes the account first: skipped, granted next pass.
        // `updatedAt` = `createdAt` marks an account no sign-in has written to yet.
        const now = new Date();
        const rows = await tx.user.createManyAndReturn({
          select: { oidcSubject: true },
          data: plan.create.map((h) => ({
            createdAt: now,
            updatedAt: now,
            oidcSubject: h.subject,
            displayName: h.name?.trim() || UNNAMED_HOST,
            email: null,
            roles: [UserRole.host],
            assignedRoles: [UserRole.host],
          })),
          skipDuplicates: true,
        });
        made = rows.map((r) => r.oidcSubject);
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
      // Upstream has no account deletion and keeps no last sign-in, so a hard delete,
      // guarded so it can never take data: never written since the sync made it (a
      // sign-in writes the token's name and email), no email, and nothing owned or
      // played (quizzes and logs would block it; templates, the host seat would
      // cascade). A sign-in racing this pass makes the guard fail: role only.
      let removed = 0;
      const revoke = [...plan.revoke];
      for (const subject of plan.remove) {
        const { count } = await tx.user.deleteMany({
          where: {
            oidcSubject: subject,
            email: null,
            updatedAt: { equals: tx.user.fields.createdAt },
            quizzes: { none: {} },
            mediaAssets: { none: {} },
            themes: { none: {} },
            selections: { none: {} },
            hostedSessions: { none: {} },
            playerResults: { none: {} },
            escapeTemplates: { none: {} },
            hostSeat: { is: null },
          },
        });
        if (count) removed += count;
        else revoke.push(subject); // In use after all: only the role goes.
      }
      for (const subject of revoke) {
        const u = await tx.user.findUnique({ where: { oidcSubject: subject } });
        if (!u) continue;
        const without = (roles: UserRole[]) => roles.filter((r) => r !== UserRole.host);
        await tx.user.update({
          where: { id: u.id },
          data: { assignedRoles: without(u.assignedRoles), roles: without(u.roles) },
        });
      }
      const own = [
        // Only the accounts this pass made are `created` (deletable before a sign-in).
        ...made.map((oidcSubject) => ({ oidcSubject, created: true })),
        ...plan.grant.map((oidcSubject) => ({ oidcSubject, created: false })),
      ];
      if (own.length) {
        await tx.escapeSiteHost.createMany({ data: own, skipDuplicates: true });
      }
      const drop = [...revoke, ...plan.release, ...plan.remove];
      if (drop.length) await tx.escapeSiteHost.deleteMany({ where: { oidcSubject: { in: drop } } });
      return removed;
    });
  }
}
