import { UserRole } from '@prisma/client';
import type { z } from 'zod';
import type { SiteResult } from './site-client';
import {
  type KnownUser,
  SiteStateLog,
  fetchSiteHosts,
  planHostSync,
  refuseHostSync,
  siteHostSyncEnabled,
} from './site-hosts';

const user = (
  oidcSubject: string,
  assignedRoles: UserRole[] = [],
  deletedAt: Date | null = null,
  email: string | null = null,
): KnownUser => ({
  oidcSubject,
  assignedRoles,
  deletedAt,
  email,
});

describe('planHostSync', () => {
  it('makes an account for a Site host Live has never seen, and owns it', () => {
    expect(planHostSync([{ subject: 'a', name: 'Ann' }], [], [])).toEqual({
      create: [{ subject: 'a', name: 'Ann' }],
      grant: [],
      revoke: [],
      release: [],
      remove: [],
    });
  });

  it('grants host to a known account without it, keeping its other roles', () => {
    const plan = planHostSync([{ subject: 'a', name: null }], [user('a', [UserRole.admin])], []);
    expect(plan.grant).toEqual(['a']);
    expect(plan.create).toEqual([]);
  });

  it("leaves an operator's host grant alone: not granted again, not owned", () => {
    const plan = planHostSync([{ subject: 'a', name: null }], [user('a', [UserRole.host])], []);
    expect(plan).toEqual({ create: [], grant: [], revoke: [], release: [], remove: [] });
  });

  it('keeps a grant it owns while the Site still lists the host', () => {
    const plan = planHostSync([{ subject: 'a', name: null }], [user('a', [UserRole.host])], ['a']);
    expect(plan).toEqual({ create: [], grant: [], revoke: [], release: [], remove: [] });
  });

  it('takes back host from an owned grant the Site no longer lists', () => {
    const plan = planHostSync([], [user('a', [UserRole.admin, UserRole.host])], ['a']);
    expect(plan).toEqual({ create: [], grant: [], revoke: ['a'], release: [], remove: [] });
  });

  it('never revokes a host grant it does not own', () => {
    const plan = planHostSync([], [user('a', [UserRole.host])], []);
    expect(plan).toEqual({ create: [], grant: [], revoke: [], release: [], remove: [] });
  });

  it('releases an owned grant whose account is gone or no longer holds host', () => {
    expect(planHostSync([], [user('b')], ['a', 'b']).release).toEqual(['a', 'b']);
  });

  it('skips a deleted account', () => {
    const plan = planHostSync([{ subject: 'a', name: null }], [user('a', [], new Date())], []);
    expect(plan).toEqual({ create: [], grant: [], revoke: [], release: [], remove: [] });
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

describe('planHostSync: accounts the sync made', () => {
  const created = new Set(['a']);

  it('removes an account it made that never signed in (no email) once the Site drops it', () => {
    const plan = planHostSync([], [user('a', [UserRole.host])], ['a'], created);
    expect(plan).toEqual({ create: [], grant: [], revoke: [], release: [], remove: ['a'] });
  });

  it('only takes back host from an account it made that has signed in since (an email)', () => {
    const signedIn = user('a', [UserRole.host], null, 'a@example.com');
    const plan = planHostSync([], [signedIn], ['a'], created);
    expect(plan).toEqual({ create: [], grant: [], revoke: ['a'], release: [], remove: [] });
  });

  it('only takes back host from an account it did not make', () => {
    const plan = planHostSync([], [user('a', [UserRole.host])], ['a']);
    expect(plan.revoke).toEqual(['a']);
    expect(plan.remove).toEqual([]);
  });

  it('keeps an account it made while the Site lists it', () => {
    const plan = planHostSync(
      [{ subject: 'a', name: null }],
      [user('a', [UserRole.host])],
      ['a'],
      created,
    );
    expect(plan.remove).toEqual([]);
  });
});

describe('refuseHostSync', () => {
  const plan = (revoke: string[], remove: string[] = []) => ({
    create: [],
    grant: [],
    revoke,
    release: [],
    remove,
  });

  it('refuses an empty Site list while the sync owns grants', () => {
    expect(refuseHostSync([], ['a'], plan(['a']))).toMatch(/no hosts/);
  });

  it('lets an empty list through when nothing is owned', () => {
    expect(refuseHostSync([], [], plan([]))).toBeNull();
  });

  it('refuses taking back more than half of the owned grants when that is 3 or more', () => {
    const owned = ['a', 'b', 'c', 'd', 'e'];
    const hosts = [{ subject: 'e', name: null }];
    expect(refuseHostSync(hosts, owned, plan(['a', 'b'], ['c']))).toMatch(/3 of 5/);
  });

  it('lets through taking back 3 when that is half or less, or fewer than 3 whatever the share', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'];
    const hosts = [{ subject: 'f', name: null }];
    expect(refuseHostSync(hosts, six, plan(['a', 'b', 'c']))).toBeNull();
    expect(refuseHostSync(hosts, ['a', 'b', 'f'], plan(['a', 'b']))).toBeNull();
  });
});

describe('SiteStateLog', () => {
  const logger = () => ({ warn: jest.fn(), log: jest.fn() });

  it('logs the first failure and the recovery, not every failed pass', () => {
    const l = logger();
    const state = new SiteStateLog(l);
    state.up(); // up at boot: nothing to say
    state.warn('site api/live/hosts: unavailable (network: x)');
    state.warn('site api/live/hosts: unavailable (network: x)');
    state.warn('site api/live/hosts: unavailable (timeout: y)');
    expect(l.warn).toHaveBeenCalledTimes(1);
    expect(l.warn.mock.calls[0][0]).toMatch(/unavailable \(network: x\)/);
    state.up();
    state.up();
    expect(l.log).toHaveBeenCalledTimes(1);
    state.warn('again');
    expect(l.warn).toHaveBeenCalledTimes(2);
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
