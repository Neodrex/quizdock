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
  const carl = `${tag}-carl`; // a facilitator who never signs in
  const dan = `${tag}-dan`; // a facilitator the Site keeps listing
  const many = [1, 2, 3].map((i) => `${tag}-e${i}`);
  const subjects = [ann, bob, op, carl, dan, ...many];
  let hosts: { subject: string; name: string | null }[] = [];

  const signIn = (sub: string) =>
    ctx.h.app.get(UsersService).upsertFromPrincipal({
      sub,
      displayName: `${sub} (token)`,
      email: null,
      roles: [],
    });

  beforeAll(async () => {
    // The take-back limit counts every owned row: drop those of earlier runs.
    await ctx.h.prisma.escapeSiteHost.deleteMany({ where: { oidcSubject: { startsWith: 'sh-' } } });
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
      { subject: carl, name: 'Carl' },
      { subject: dan, name: 'Dan' },
    ];
    await sync.syncOnce();
    const rows = await ctx.h.prisma.escapeSiteHost.findMany({
      where: { oidcSubject: { in: subjects } },
      orderBy: { oidcSubject: 'asc' },
    });
    expect(rows.map((r) => [r.oidcSubject, r.created])).toEqual([
      [ann, true],
      [bob, false],
      [carl, true],
      [dan, true],
    ]);
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

  const find = (sub: string) => ctx.h.prisma.user.findUnique({ where: { oidcSubject: sub } });
  const owns = async (sub: string) =>
    (await ctx.h.prisma.escapeSiteHost.findUnique({ where: { oidcSubject: sub } })) !== null;

  it("a host the Site drops loses host, even after a later set-role; an operator's own grant stays", async () => {
    // An operator's `set-role host` on an owned user does not keep host.
    await ctx.h.prisma.user.update({
      where: { oidcSubject: bob },
      data: { assignedRoles: [UserRole.host], roles: [UserRole.host] },
    });
    hosts = [ann, carl, dan].map((subject) => ({ subject, name: null }));
    await sync.syncOnce();
    expect((await signIn(bob)).roles).toEqual([]);
    expect((await signIn(ann)).roles).toEqual([UserRole.host]);
    expect((await signIn(op)).roles).toEqual([UserRole.host]);
    expect(await owns(bob)).toBe(false);
  });

  it('an account it made that has signed in keeps existing, without host', async () => {
    hosts = [carl, dan].map((subject) => ({ subject, name: null }));
    await sync.syncOnce();
    expect(await find(ann)).toMatchObject({ assignedRoles: [], roles: [] });
    expect((await signIn(ann)).roles).toEqual([]);
    expect(await owns(ann)).toBe(false);
  });

  it('an account it made that never signed in is deleted', async () => {
    expect(await find(carl)).toMatchObject({ email: null, assignedRoles: [UserRole.host] });
    hosts = [{ subject: dan, name: null }];
    await sync.syncOnce();
    expect(await find(carl)).toBeNull();
    expect(await owns(carl)).toBe(false);
    expect(await find(dan)).toMatchObject({ assignedRoles: [UserRole.host] });
  });

  it('an empty Site list changes nothing while grants are owned', async () => {
    hosts = [];
    await sync.syncOnce();
    expect(await find(dan)).toMatchObject({ assignedRoles: [UserRole.host] });
    expect(await owns(dan)).toBe(true);
    expect((await signIn(op)).roles).toEqual([UserRole.host]);
  });

  it('a pass taking back more than half of the owned grants (3 or more) changes nothing', async () => {
    hosts = [dan, ...many].map((subject) => ({ subject, name: null }));
    await sync.syncOnce();
    hosts = [{ subject: dan, name: null }];
    await sync.syncOnce();
    for (const sub of many) {
      expect(await find(sub)).toMatchObject({ assignedRoles: [UserRole.host] });
      expect(await owns(sub)).toBe(true);
    }
  });
}
