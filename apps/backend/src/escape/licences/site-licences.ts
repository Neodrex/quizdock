import { type Logger, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { type SiteClient, siteHostOf } from '../site/site-client';
import { siteBrandSchema } from '../site/site-brand';
import type {
  Licence,
  LicenceCheck,
  LicenceHost,
  LicencePort,
  LicenceRefusal,
  LicenceUse,
} from './licence.port';

/** `usableBy` answers are kept this long per host (M8 §5 item 6); `check` and `use` never. */
export const USABLE_CACHE_MS = 10_000;

/** The Site down while listing licences: the picker and a create without a choice say so. */
export const LICENCE_UNAVAILABLE = 'escape.licence_unavailable';

const ms = z.number().int().nonnegative();
const SITE_REFUSALS = [
  'not-found',
  'not-a-facilitator',
  'not-yet-valid',
  'expired',
  'no-events-left',
] as const;
const USE_REFUSALS = ['not-found', 'not-yet-valid', 'expired', 'no-events-left'] as const;

/**
 * `ESCAPE_LICENCE_SOURCE=site` (M8 Task 8.13): the licences, facilitators and
 * uses live on the Site, asked through its internal API (§1.2). The host is
 * sent by its OIDC subject (the Site's user id). Unreachable or refusing in an
 * unexpected way: `unavailable`, so a hosted event never opens or starts blind.
 */
export class SiteLicences implements LicencePort {
  private readonly usable = new Map<string, { at: number; list: Licence[] }>();
  private readonly licence: z.ZodType<Licence>;
  private readonly checkAnswer: z.ZodType<
    { ok: true; licence: Licence } | { ok: false; reason: (typeof SITE_REFUSALS)[number] }
  >;

  constructor(
    private readonly site: Pick<SiteClient, 'post'>,
    private readonly log: Pick<Logger, 'warn'>,
  ) {
    const brand = siteBrandSchema(this.log);
    this.licence = z.object({
      id: z.string().min(1).max(64),
      organisationId: z.string().min(1).max(64),
      package: z.enum(['single', 'bundle', 'annual']),
      participantCap: z.number().int().min(1).max(2000),
      validFrom: ms.nullable(),
      expiresAt: ms,
      eventsLeft: z.number().int().nonnegative().nullable(),
      brand: brand.nullable(),
    });
    this.checkAnswer = z.union([
      z.object({ ok: z.literal(true), licence: this.licence }),
      z.object({ ok: z.literal(false), reason: z.enum(SITE_REFUSALS) }),
    ]);
  }

  /** Throws `escape.licence_unavailable` (503) when the Site cannot answer. */
  async usableBy(host: LicenceHost, now: number): Promise<Licence[]> {
    const key = host.oidcSubject;
    const kept = this.usable.get(key);
    if (kept && now - kept.at >= 0 && now - kept.at < USABLE_CACHE_MS) return kept.list;
    const res = await this.site.post(
      '/api/live/licences/usable',
      { host: siteHostOf(host) },
      z.array(this.licence),
    );
    if (!res.ok) throw new ServiceUnavailableException(LICENCE_UNAVAILABLE);
    this.usable.set(key, { at: now, list: res.value });
    return res.value;
  }

  async check(host: LicenceHost, licenceId: string): Promise<LicenceCheck> {
    const res = await this.site.post(
      '/api/live/licences/check',
      { host: siteHostOf(host), licenceId },
      this.checkAnswer,
    );
    return res.ok ? res.value : { ok: false, reason: 'unavailable' };
  }

  /** Idempotent by `useKey` on the Site, so a network error is retried once. */
  async recordUse(
    licenceId: string,
    use: LicenceUse,
  ): Promise<{ ok: true } | { ok: false; reason: LicenceRefusal }> {
    const answer = z.union([
      z.object({ ok: z.literal(true) }),
      z.object({ ok: z.literal(false), reason: z.enum(USE_REFUSALS) }),
    ]);
    const body = { licenceId, use };
    let res = await this.site.post('/api/live/licences/use', body, answer);
    if (!res.ok && res.cause === 'network') {
      res = await this.site.post('/api/live/licences/use', body, answer);
    }
    if (!res.ok) return { ok: false, reason: 'unavailable' };
    return res.value.ok ? { ok: true } : { ok: false, reason: res.value.reason };
  }
}
