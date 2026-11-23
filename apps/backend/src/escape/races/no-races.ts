import type { RaceClaim, RacePort } from './race.port';

/** No Site (`ESCAPE_SITE_URL` empty): no Site race exists; races made on Live still work. */
export class NoRaces implements RacePort {
  claim(): Promise<RaceClaim> {
    return Promise.resolve({ ok: false, reason: 'not-found' });
  }

  opened(): Promise<void> {
    return Promise.resolve();
  }

  finished(): Promise<void> {
    return Promise.resolve();
  }
}
