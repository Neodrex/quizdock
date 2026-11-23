import { BUILTIN_THEME_VALUES, type EscapeLook, mergeTheme } from '@quiz-dock/contracts';

/** Acme's look as the server sends it (dev licence: accent #c2410c on classic). Tests only. */
export const ACME_LOOK: EscapeLook = {
  theme: mergeTheme(BUILTIN_THEME_VALUES.classic, { accent: '#c2410c' }),
  brand: { name: 'Acme', logoUrl: 'https://acme.example/logo.png', intro: 'Welcome, Acme team.' },
};
