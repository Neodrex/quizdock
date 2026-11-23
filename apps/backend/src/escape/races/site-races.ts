import type { Logger } from '@nestjs/common';
import { z } from 'zod';
import type { LicenceHost } from '../licences/licence.port';
import { type SiteClient, siteHostOf } from '../site/site-client';
import { siteBrandSchema } from '../site/site-brand';
import {
  RACE_RESULTS_TOP,
  type RaceClaim,
  type RaceOpened,
  type RacePort,
  type RaceResults,
  type SiteRace,
} from './race.port';

/** What the Site accepts as a PIN (§1.2); Live's are 6 digits. */
export const SITE_PIN = /^[A-Za-z0-9-]{1,16}$/;

const answer = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: z.string().max(64) }),
]);

const openedAnswer = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: z.enum(['not-found', 'not-open']) }),
]);

/**
 * Site races (M8 Task 8.14): claimed at create, then `opened` with the PIN and
 * `finished` with the top teams. The claim fails closed (`unavailable`); the
 * two reports are best effort: a refusal is logged and the room carries on.
 */
export class SiteRaces implements RacePort {
  private readonly claimAnswer: z.ZodType<RaceClaim>;

  constructor(
    private readonly site: Pick<SiteClient, 'post'>,
    private readonly log: Pick<Logger, 'warn'>,
  ) {
    const race: z.ZodType<SiteRace> = z.object({
      title: z.string().max(200),
      startsAt: z.number().int().positive(),
      format: z.enum(['solo', 'teams']),
      brand: siteBrandSchema(log).nullable(),
    });
    this.claimAnswer = z.union([
      z.object({ ok: z.literal(true), race }),
      z.object({ ok: z.literal(false), reason: z.enum(['not-found', 'not-allowed', 'not-open']) }),
    ]);
  }

  async claim(host: LicenceHost, siteRaceId: string): Promise<RaceClaim> {
    const res = await this.site.post(
      this.path(siteRaceId, 'claim'),
      { host: siteHostOf(host) },
      this.claimAnswer,
    );
    return res.ok ? res.value : { ok: false, reason: 'unavailable' };
  }

  async opened(siteRaceId: string, pin: string): Promise<RaceOpened> {
    if (!SITE_PIN.test(pin)) {
      this.log.warn(`site race ${siteRaceId}: PIN ${pin} is not one the Site takes; not reported`);
      return { ok: false, reason: 'unavailable' };
    }
    const res = await this.site.post(this.path(siteRaceId, 'opened'), { pin }, openedAnswer);
    if (!res.ok) return { ok: false, reason: 'unavailable' };
    if (!res.value.ok) {
      this.log.warn(`site race ${siteRaceId}: opened refused (${res.value.reason})`);
    }
    return res.value;
  }

  async finished(siteRaceId: string, results: RaceResults): Promise<void> {
    const body = { ...results, top: results.top.slice(0, RACE_RESULTS_TOP) };
    const path = this.path(siteRaceId, 'results');
    let res = await this.site.post(path, body, answer);
    if (!res.ok) res = await this.site.post(path, body, answer);
    if (!res.ok) {
      this.log.warn(`site race ${siteRaceId}: results not delivered; record them on the Site`);
    } else if (!res.value.ok) {
      this.log.warn(`site race ${siteRaceId}: results refused (${res.value.reason})`);
    }
  }

  private path(siteRaceId: string, what: string): string {
    return `/api/live/races/${encodeURIComponent(siteRaceId)}/${what}`;
  }
}
