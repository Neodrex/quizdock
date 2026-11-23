import { UserRole } from '@prisma/client';
import type { z } from 'zod';
import type { SiteResult } from './site-client';
import { type KnownUser, fetchSiteHosts, planHostSync, siteHostSyncEnabled } from './site-hosts';

const user = (
  oidcSubject: string,
  assignedRoles: UserRole[] = [],
  deletedAt: Date | null = null,
): KnownUser => ({
  oidcSubject,
  assignedRoles,
  deletedAt,
});

describe('planHostSync', () => {
  it('makes an account for a Site host Live has never seen, and owns it', () => {
    expect(planHostSync([{ subject: 'a', name: 'Ann' }], [], [])).toEqual({
      create: [{ subject: 'a', name: 'Ann' }],
      grant: [],
      revoke: [],
      release: [],
    });
  });

  it('grants host to a known account without it, keeping its other roles', () => {
    const plan = planHostSync([{ subject: 'a', name: null }], [user('a', [UserRole.admin])], []);
    expect(plan.grant).toEqual(['a']);
    expect(plan.create).toEqual([]);
  });

  it("leaves an operator's host grant alone: not granted again, not owned", () => {
    const plan = planHostSync([{ subject: 'a', name: null }], [user('a', [UserRole.host])], []);
    expect(plan).toEqual({ create: [], grant: [], revoke: [], release: [] });
  });

  it('keeps a grant it owns while the Site still lists the host', () => {
    const plan = planHostSync([{ subject: 'a', name: null }], [user('a', [UserRole.host])], ['a']);
    expect(plan).toEqual({ create: [], grant: [], revoke: [], release: [] });
  });

  it('takes back host from an owned grant the Site no longer lists', () => {
    const plan = planHostSync([], [user('a', [UserRole.admin, UserRole.host])], ['a']);
    expect(plan).toEqual({ create: [], grant: [], revoke: ['a'], release: [] });
  });

  it('never revokes a host grant it does not own', () => {
    const plan = planHostSync([], [user('a', [UserRole.host])], []);
    expect(plan).toEqual({ create: [], grant: [], revoke: [], release: [] });
  });

  it('releases an owned grant whose account is gone or no longer holds host', () => {
    expect(planHostSync([], [user('b')], ['a', 'b']).release).toEqual(['a', 'b']);
  });

  it('skips a deleted account', () => {
    const plan = planHostSync([{ subject: 'a', name: null }], [user('a', [], new Date())], []);
    expect(plan).toEqual({ create: [], grant: [], revoke: [], release: [] });
  });

  it('lists each subject once, whatever the Site repeats', () => {
    const plan = planHostSync(
      [
        { subject: 'a', name: 'Ann' },
        { subject: 'a', name: 'Ann' },
      ],
      [],
      [],
    );
    expect(plan.create).toEqual([{ subject: 'a', name: 'Ann' }]);
  });
});

describe('fetchSiteHosts', () => {
  const site = (raw: unknown | SiteResult<unknown>) => {
    const calls: { path: string; body: unknown }[] = [];
    const post = jest.fn((path: string, body: unknown, schema: z.ZodType) => {
      calls.push({ path, body });
      if (raw && typeof raw === 'object' && 'ok' in raw)
        return Promise.resolve(raw as SiteResult<never>);
      const parsed = schema.safeParse(raw);
      return Promise.resolve(
        (parsed.success
          ? { ok: true, value: parsed.data }
          : { ok: false, reason: 'unavailable', cause: 'answer' }) as SiteResult<never>,
      );
    });
    return { post, calls };
  };

  it('POSTs an empty body to api/live/hosts and gives the hosts', async () => {
    const s = site({
      hosts: [
        { subject: 'a', name: 'Ann' },
        { subject: 'b', name: null },
      ],
    });
    expect(await fetchSiteHosts(s)).toEqual([
      { subject: 'a', name: 'Ann' },
      { subject: 'b', name: null },
    ]);
    expect(s.calls).toEqual([{ path: 'api/live/hosts', body: {} }]);
  });

  it('gives null when the Site is unavailable or answers another shape', async () => {
    expect(
      await fetchSiteHosts(site({ ok: false, reason: 'unavailable', cause: 'network' })),
    ).toBeNull();
    expect(await fetchSiteHosts(site({ hosts: [{ subject: '' }] }))).toBeNull();
    expect(await fetchSiteHosts(site([]))).toBeNull();
  });
});

describe('siteHostSyncEnabled', () => {
  it('runs under OIDC with a Site only', () => {
    expect(siteHostSyncEnabled('oidc', 'https://site.example')).toBe(true);
    expect(siteHostSyncEnabled('oidc', ' ')).toBe(false);
    expect(siteHostSyncEnabled('none', 'https://site.example')).toBe(false);
  });
});
