import { UserRole } from '@prisma/client';
import { SiteHostSync } from '../../src/escape/site/site-hosts';
import { UsersService } from '../../src/users/users.service';
import type { EscapeContext } from './escape-harness';
import { type SiteStub, startSiteStub } from './site-stub';

/**
 * M8 §5 item 2: Live's `host` role from the Site's host list, with no role in
 * any token. The sign-in is the real `upsertFromPrincipal` with the roles a
 * Supabase ID token gives: none.
 */
export function siteHostTests(ctx: EscapeContext): void {
  let site: SiteStub;
  let sync: SiteHostSync;
  const tag = `sh-${Date.now()}`;
  const ann = `${tag}-ann`; // a facilitator, unseen by Live before the sync
  const bob = `${tag}-bob`; // signed in before, as a participant
  const op = `${tag}-op`; // host by an operator's grant
  const subjects = [ann, bob, op];
  let hosts: { subject: string; name: string | null }[] = [];

  const signIn = (sub: string) =>
    ctx.h.app.get(UsersService).upsertFromPrincipal({
      sub,
      displayName: `${sub} (token)`,
      email: null,
      roles: [],
    });

  beforeAll(async () => {
    site = await startSiteStub();
    site.answers.set('/api/live/hosts', () => ({ hosts }));
    sync = new SiteHostSync(ctx.h.prisma as never, site.client());
    await signIn(bob);
    await signIn(op);
    await ctx.h.prisma.user.update({
      where: { oidcSubject: op },
      data: { assignedRoles: [UserRole.host], roles: [UserRole.host] },
    });
  });

  afterAll(async () => {
    await ctx.h.prisma.escapeSiteHost.deleteMany({ where: { oidcSubject: { in: subjects } } });
    await ctx.h.prisma.user.deleteMany({ where: { oidcSubject: { in: subjects } } });
    await site.close();
  });

  it('a Site host is a host at the first sign-in, and a known participant at the next', async () => {
    hosts = [
      { subject: ann, name: 'Ann' },
      { subject: bob, name: null },
    ];
    await sync.syncOnce();
    const before = await ctx.h.prisma.user.findUnique({ where: { oidcSubject: ann } });
    expect(before).toMatchObject({
      displayName: 'Ann',
      email: null,
      assignedRoles: [UserRole.host],
    });
    expect((await signIn(ann)).roles).toEqual([UserRole.host]);
    expect((await signIn(ann)).displayName).toBe(`${ann} (token)`);
    expect((await signIn(bob)).roles).toEqual([UserRole.host]);
  });

  it('the Site cannot be reached: every grant stays', async () => {
    site.down = true;
    hosts = [];
    await sync.syncOnce();
    site.down = false;
    expect((await signIn(ann)).roles).toEqual([UserRole.host]);
  });

  it("a host the Site drops loses host; an operator's grant stays", async () => {
    hosts = [{ subject: ann, name: 'Ann' }];
    await sync.syncOnce();
    expect((await signIn(bob)).roles).toEqual([]);
    expect((await signIn(ann)).roles).toEqual([UserRole.host]);
    expect((await signIn(op)).roles).toEqual([UserRole.host]);
    hosts = [];
    await sync.syncOnce();
    expect((await signIn(ann)).roles).toEqual([]);
    expect((await signIn(op)).roles).toEqual([UserRole.host]);
    const owned = await ctx.h.prisma.escapeSiteHost.findMany({
      where: { oidcSubject: { in: subjects } },
    });
    expect(owned).toEqual([]);
  });
}
