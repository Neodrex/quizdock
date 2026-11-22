import type { StaticLicence } from './static-licences';

/**
 * The development and test licences (M7 §1.2): every host gets them. The tests
 * load them through `StaticLicences.replace`, devenv through the setting.
 */
export const DEV_LICENCE: StaticLicence = {
  id: 'dev-licence',
  organisationId: 'dev-org',
  package: 'annual',
  participantCap: 500,
  validFrom: null,
  expiresAt: Date.UTC(2100, 0, 1),
  eventsLeft: null,
  brand: null,
  hosts: ['*'],
};

export const ACME_LICENCE: StaticLicence = {
  id: 'acme',
  organisationId: 'acme-org',
  package: 'bundle',
  participantCap: 8,
  validFrom: null,
  expiresAt: Date.UTC(2100, 0, 1),
  eventsLeft: 2,
  brand: {
    name: 'Acme',
    logoUrl: 'http://localhost:5173/escape-dev/acme-logo.png',
    accent: '#c2410c',
    background: null,
    baseTheme: 'classic',
    intro: 'Welcome to the Acme team escape.',
  },
  hosts: ['*'],
};

export const EXPIRED_LICENCE: StaticLicence = {
  id: 'expired-co',
  organisationId: 'expired-org',
  package: 'single',
  participantCap: 30,
  validFrom: null,
  expiresAt: Date.UTC(2020, 0, 1),
  eventsLeft: 1,
  brand: null,
  hosts: ['*'],
};

export const DEV_LICENCES: StaticLicence[] = [DEV_LICENCE, ACME_LICENCE, EXPIRED_LICENCE];
