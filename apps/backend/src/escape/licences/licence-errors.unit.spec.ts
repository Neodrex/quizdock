import { licenceErrorCode } from './licence-errors';
import type { LicenceRefusal } from './licence.port';

describe('licenceErrorCode', () => {
  it.each<[LicenceRefusal, string]>([
    ['not-found', 'escape.licence_not_found'],
    ['not-a-facilitator', 'escape.licence_not_facilitator'],
    ['not-yet-valid', 'escape.licence_not_yet_valid'],
    ['expired', 'escape.licence_expired'],
    ['no-events-left', 'escape.licence_no_events_left'],
    ['unavailable', 'escape.licence_unavailable'],
  ])('%s gives %s', (reason, code) => {
    expect(licenceErrorCode(reason)).toBe(code);
  });
});
