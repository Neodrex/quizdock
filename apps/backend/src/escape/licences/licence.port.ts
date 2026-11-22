/**
 * The licence port (M7 §1.2): the seam between the engine and whoever owns the
 * licences. M7 ships a static source fed by settings; M8 adds the Site's
 * internal API behind the same interface, and the engine does not change.
 */
import type { BuiltinTheme } from '@quiz-dock/contracts';

export const LICENCE_PORT = Symbol('LICENCE_PORT');

/** The host asking, as the engine knows them. */
export interface LicenceHost {
  userId: string;
  email: string | null;
  oidcSubject: string;
}

export interface LicenceBrand {
  /** The organisation as shown ("Acme Ltd"). */
  name: string;
  /** https only (the static source also takes http://localhost). */
  logoUrl: string | null;
  /** HEX_COLOR. */
  accent: string;
  /** HEX_COLOR; null: the base theme's. */
  background: string | null;
  baseTheme: BuiltinTheme;
  /** At most 280 characters, plain text, shown on the screen lobby. */
  intro: string | null;
}

export interface Licence {
  id: string;
  organisationId: string;
  package: 'single' | 'bundle' | 'annual';
  /** 1..2000. */
  participantCap: number;
  /** ms epoch; null: valid from its creation. */
  validFrom: number | null;
  /** ms epoch. */
  expiresAt: number;
  /** null: annual (uses counted for the record only). */
  eventsLeft: number | null;
  brand: LicenceBrand | null;
}

export type LicenceRefusal =
  | 'not-found'
  | 'not-a-facilitator'
  | 'not-yet-valid'
  | 'expired'
  | 'no-events-left'
  | 'unavailable';

export type LicenceCheck = { ok: true; licence: Licence } | { ok: false; reason: LicenceRefusal };

export interface LicenceUse {
  /** The room id: a second use under the same key changes nothing. */
  useKey: string;
  pin: string;
  gameId: string;
  startedAt: number;
  players: number;
}

export interface LicencePort {
  /** The licences this host may run a hosted event under now (for the create picker). */
  usableBy(host: LicenceHost, now: number): Promise<Licence[]>;
  /** One licence for this host, checked now. Never throws for a refusal. */
  check(host: LicenceHost, licenceId: string, now: number): Promise<LicenceCheck>;
  /** A hosted room's first start (owner question 4). Idempotent by `useKey`. */
  recordUse(
    licenceId: string,
    use: LicenceUse,
  ): Promise<{ ok: true } | { ok: false; reason: LicenceRefusal }>;
}
