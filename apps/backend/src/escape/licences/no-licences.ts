import type { LicenceCheck, LicencePort } from './licence.port';

/** `ESCAPE_LICENCE_SOURCE=none` (the default): no hosted events; group play and races still work. */
export class NoLicences implements LicencePort {
  usableBy(): Promise<[]> {
    return Promise.resolve([]);
  }

  check(): Promise<LicenceCheck> {
    return Promise.resolve({ ok: false, reason: 'not-found' });
  }

  recordUse(): Promise<{ ok: false; reason: 'not-found' }> {
    return Promise.resolve({ ok: false, reason: 'not-found' });
  }
}
