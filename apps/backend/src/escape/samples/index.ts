import type { EscapeTemplateContent } from '@quiz-dock/contracts';
import { lostLibrary } from './lost-library';
import { vaultHeist } from './vault-heist';

export { lostLibrary, vaultHeist };

/** The sample templates a host can add to try escape rooms. */
export const SAMPLES: readonly EscapeTemplateContent[] = [vaultHeist, lostLibrary];
