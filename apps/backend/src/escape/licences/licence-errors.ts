import type { LicenceRefusal } from './licence.port';

/** No licence chosen, and none or several usable. */
export const LICENCE_REQUIRED = 'escape.licence_required';

/** The error code a host sees for a licence refusal (pure, exhaustive). */
export function licenceErrorCode(reason: LicenceRefusal): string {
  switch (reason) {
    case 'not-found':
      return 'escape.licence_not_found';
    case 'not-a-facilitator':
      return 'escape.licence_not_facilitator';
    case 'not-yet-valid':
      return 'escape.licence_not_yet_valid';
    case 'expired':
      return 'escape.licence_expired';
    case 'no-events-left':
      return 'escape.licence_no_events_left';
    case 'unavailable':
      return 'escape.licence_unavailable';
    default: {
      const never: never = reason;
      return never;
    }
  }
}
