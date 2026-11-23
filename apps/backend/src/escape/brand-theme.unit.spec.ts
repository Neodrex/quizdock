import {
  BUILTIN_THEME_VALUES,
  themeAccessibility,
  themeOverridesSchema,
} from '@quiz-dock/contracts';
import { z } from 'zod';
import { brandThemeOf } from './brand-theme';

/** Every part of a ThemeValues, as the contracts' theme schema defines them. */
const themeValuesShape = themeOverridesSchema(z.string()).required();

describe('brandThemeOf', () => {
  it('sets the accent and keeps the base theme otherwise', () => {
    const theme = brandThemeOf({ accent: '#c2410c', background: null, baseTheme: 'classic' });
    expect(theme.accent).toBe('#c2410c');
    expect(theme.background).toEqual(BUILTIN_THEME_VALUES.classic.background);
    expect(theme.slots).toEqual(BUILTIN_THEME_VALUES.classic.slots);
  });

  it('sets the background colour with the text tone that reads on it', () => {
    const dark = brandThemeOf({ accent: '#f59e0b', background: '#111827', baseTheme: 'classic' });
    expect(dark.background).toEqual({ color: '#111827', textTone: 'light' });
    const light = brandThemeOf({ accent: '#c2410c', background: '#fef3c7', baseTheme: 'classic' });
    expect(light.background).toEqual({ color: '#fef3c7', textTone: 'dark' });
  });

  it('a background the accessibility check flags falls back to the base theme’s', () => {
    // A mid grey: the slots no longer stand out on it, nor does the accent.
    const theme = brandThemeOf({ accent: '#c2410c', background: '#777777', baseTheme: 'classic' });
    expect(theme.background).toEqual(BUILTIN_THEME_VALUES.classic.background);
    expect(theme.accent).toBe('#c2410c');
  });

  it('the base theme defaults to classic', () => {
    expect(brandThemeOf({ accent: '#c2410c', background: null })).toEqual(
      brandThemeOf({ accent: '#c2410c', background: null, baseTheme: 'classic' }),
    );
    const night = brandThemeOf({ accent: '#c2410c', background: null, baseTheme: 'night' });
    expect(night.background).toEqual(BUILTIN_THEME_VALUES.night.background);
  });

  it('gives a full ThemeValues that passes the contracts’ shape check', () => {
    for (const background of [null, '#111827', '#777777']) {
      const theme = brandThemeOf({ accent: '#c2410c', background, baseTheme: 'classic' });
      expect(themeValuesShape.safeParse(theme).success).toBe(true);
      // The shipped slots' own text check aside, the text reads on the background.
      const text = themeAccessibility(theme).checks.find(
        (c) => c.code === 'text_background_contrast',
      );
      expect(text?.passed).toBe(true);
    }
  });
});
