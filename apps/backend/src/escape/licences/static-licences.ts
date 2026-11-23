import { z } from 'zod';
import { licenceBrandSchema } from './brand-schema';
import type {
  Licence,
  LicenceCheck,
  LicenceHost,
  LicencePort,
  LicenceRefusal,
  LicenceUse,
} from './licence.port';

/** A licence as ESCAPE_STATIC_LICENCES lists it: who may use it, by user id, email or `*`. */
export type StaticLicence = Licence & { hosts: string[] };

const ms = z.number().int().nonnegative();
const licenceSchema = z.object({
  id: z.string().min(1).max(64),
  organisationId: z.string().min(1).max(64),
  package: z.enum(['single', 'bundle', 'annual']),
  participantCap: z.number().int().min(1).max(2000),
  validFrom: ms.nullable(),
  expiresAt: ms,
  eventsLeft: z.number().int().nonnegative().nullable(),
  brand: licenceBrandSchema.nullable(),
  hosts: z.array(z.string().min(1)).min(1),
});

/** Reads the setting once at boot; anything wrong fails the boot, with its zod paths. */
export function parseStaticLicences(raw: string): StaticLicence[] {
  if (!raw.trim()) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`ESCAPE_STATIC_LICENCES is not JSON: ${(err as Error).message}`, {
      cause: err,
    });
  }
  const parsed = z.array(licenceSchema).safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`ESCAPE_STATIC_LICENCES is invalid: ${issues.join('; ')}`);
  }
  return parsed.data;
}

const isHost = (lic: StaticLicence, host: LicenceHost) =>
  lic.hosts.some(
    (h) =>
      h === '*' ||
      h === host.userId ||
      (host.email !== null && h.toLowerCase() === host.email.toLowerCase()),
  );

/** Why the licence cannot be used now, null when it can (the host aside). */
function refusalAt(lic: Licence, now: number): LicenceRefusal | null {
  if (lic.validFrom !== null && lic.validFrom > now) return 'not-yet-valid';
  if (lic.expiresAt <= now) return 'expired';
  if (lic.eventsLeft === 0) return 'no-events-left';
  return null;
}

/** What leaves the source: a copy, without its hosts. */
function out(lic: StaticLicence): Licence {
  const copy: Partial<StaticLicence> = structuredClone(lic);
  delete copy.hosts;
  return copy as Licence;
}

/**
 * `ESCAPE_LICENCE_SOURCE=static`: the licences of ESCAPE_STATIC_LICENCES, in
 * memory. Uses are counted in memory too, so a restart forgets them (§5).
 */
export class StaticLicences implements LicencePort {
  private licences: StaticLicence[] = [];
  private readonly used = new Set<string>();

  constructor(licences: StaticLicence[]) {
    this.replace(licences);
  }

  /**
   * Swaps the licences and forgets every use.
   * @internal test seam
   */
  replace(licences: StaticLicence[]): void {
    this.licences = structuredClone(licences);
    this.used.clear();
  }

  usableBy(host: LicenceHost, now: number): Promise<Licence[]> {
    return Promise.resolve(
      this.licences.filter((l) => isHost(l, host) && refusalAt(l, now) === null).map(out),
    );
  }

  check(host: LicenceHost, licenceId: string, now: number): Promise<LicenceCheck> {
    const lic = this.licences.find((l) => l.id === licenceId);
    if (!lic) return Promise.resolve({ ok: false, reason: 'not-found' });
    if (!isHost(lic, host)) return Promise.resolve({ ok: false, reason: 'not-a-facilitator' });
    const reason = refusalAt(lic, now);
    return Promise.resolve(reason ? { ok: false, reason } : { ok: true, licence: out(lic) });
  }

  recordUse(
    licenceId: string,
    use: LicenceUse,
  ): Promise<{ ok: true } | { ok: false; reason: LicenceRefusal }> {
    const lic = this.licences.find((l) => l.id === licenceId);
    if (!lic) return Promise.resolve({ ok: false, reason: 'not-found' });
    const key = `${licenceId}\n${use.useKey}`;
    if (this.used.has(key)) return Promise.resolve({ ok: true });
    if (lic.eventsLeft === 0) return Promise.resolve({ ok: false, reason: 'no-events-left' });
    if (lic.eventsLeft !== null) lic.eventsLeft -= 1;
    this.used.add(key);
    return Promise.resolve({ ok: true });
  }
}
