import {
  BUILTIN_THEME_VALUES,
  type ThemeValues,
  backgroundExtremes,
  contrast,
  oklch,
  parseHex,
  worstContrast,
} from '@quiz-dock/contracts';
import { describe, expect, it } from 'vitest';
import {
  OWN_ACCENT,
  OWN_TOKENS,
  SCREEN_GRAPHIC_CONTRAST,
  SCREEN_TEXT_CONTRAST,
  type ScreenPalette,
  screenPaletteOf,
} from './screen-palette';

const hex = parseHex;

/** Every text and edge pair the screen draws, at its threshold. */
function expectReadable(
  { tokens: k }: ScreenPalette,
  extremes: ReturnType<typeof backgroundExtremes>,
) {
  for (const text of [k.foreground, k.mutedForeground, k.destructive]) {
    expect(worstContrast(hex(text), extremes)).toBeGreaterThanOrEqual(SCREEN_TEXT_CONTRAST);
    expect(contrast(hex(text), hex(k.card))).toBeGreaterThanOrEqual(SCREEN_TEXT_CONTRAST);
  }
  expect(contrast(hex(k.cardForeground), hex(k.card))).toBeGreaterThanOrEqual(SCREEN_TEXT_CONTRAST);
  // The PIN's plate and a stage ahead carry text too.
  for (const text of [k.foreground, k.mutedForeground])
    expect(contrast(hex(text), hex(k.muted))).toBeGreaterThanOrEqual(SCREEN_TEXT_CONTRAST);
  // Places and the large banner: text on the accent.
  expect(contrast(hex(k.primaryForeground), hex(k.primary))).toBeGreaterThanOrEqual(
    SCREEN_TEXT_CONTRAST,
  );
  // A stage's fill on its track, the accent's icons, every edge.
  expect(worstContrast(hex(k.primary), extremes)).toBeGreaterThanOrEqual(SCREEN_GRAPHIC_CONTRAST);
  expect(contrast(hex(k.primary), hex(k.muted))).toBeGreaterThanOrEqual(SCREEN_GRAPHIC_CONTRAST);
  expect(contrast(hex(k.border), hex(k.card))).toBeGreaterThanOrEqual(SCREEN_GRAPHIC_CONTRAST);
}

const extremesOf = (p: ScreenPalette, theme: ThemeValues | null) =>
  p.source === 'theme' && theme
    ? backgroundExtremes(theme.background)
    : ([hex(p.tokens.background), hex(p.tokens.background)] as ReturnType<
        typeof backgroundExtremes
      >);

describe('screenPaletteOf', () => {
  it.each(Object.keys(BUILTIN_THEME_VALUES))(
    '%s: text, muted and warning reach 7:1 on the background',
    (key) => {
      const theme = BUILTIN_THEME_VALUES[key as keyof typeof BUILTIN_THEME_VALUES];
      const p = screenPaletteOf(theme);
      expectReadable(p, extremesOf(p, theme));
      // The tone follows the theme's: light text, a dark screen.
      expect(p.tone).toBe(theme.background.textTone === 'light' ? 'dark' : 'light');
    },
  );

  it('Acme’s look (an accent over classic, M7) reads at 7:1 too', () => {
    const acme = { ...BUILTIN_THEME_VALUES.classic, accent: '#c2410c' };
    const p = screenPaletteOf(acme);
    expectReadable(p, extremesOf(p, acme));
  });

  it("the screen's own tokens pass on their own, in both tones", () => {
    for (const tone of ['light', 'dark'] as const) {
      const bg = hex(OWN_TOKENS[tone].background);
      const p = screenPaletteOf({
        ...BUILTIN_THEME_VALUES.classic,
        background: { color: '#808080', textTone: tone === 'dark' ? 'light' : 'dark' },
      });
      expect(p.source).toBe('screen');
      expect(p.tokens.background).toBe(OWN_TOKENS[tone].background);
      expectReadable(p, [bg, bg]);
    }
  });

  it('draws a plain or gradient theme background that reads, never a picture', () => {
    expect(screenPaletteOf(BUILTIN_THEME_VALUES.night).source).toBe('theme');
    expect(screenPaletteOf(BUILTIN_THEME_VALUES.night).style).toMatchObject({
      '--background': BUILTIN_THEME_VALUES.night.background.color,
    });
    const kids = screenPaletteOf(BUILTIN_THEME_VALUES.kids);
    expect(kids.source).toBe('theme');
    expect(kids.style.backgroundImage).toMatch(/^linear-gradient/);
    const halloween = screenPaletteOf(BUILTIN_THEME_VALUES.halloween);
    expect(halloween.source).toBe('screen');
    expect(halloween.tone).toBe('dark');
    expect(halloween.style.backgroundImage).toBeUndefined();
  });

  it('a mid-grey theme falls back to the screen’s own tokens', () => {
    const grey = screenPaletteOf({
      ...BUILTIN_THEME_VALUES.classic,
      background: { color: '#7a7a7a', textTone: 'dark' },
    });
    expect(grey.source).toBe('screen');
    expect(grey.tokens.background).toBe('#ffffff');
  });

  it('keeps an accent that reads, moves the lightness of one that does not', () => {
    // An accent that reads already is kept as it is.
    const readable = { ...BUILTIN_THEME_VALUES.night, accent: '#ffe14d' };
    expect(screenPaletteOf(readable).tokens.primary).toBe('#ffe14d');
    // A mid blue under white text is about 5:1: darkened until 7:1, same hue.
    const mid = screenPaletteOf({ ...BUILTIN_THEME_VALUES.classic, accent: '#2b62ef' }).tokens;
    expect(mid.primary).not.toBe('#2b62ef');
    expect(mid.primaryForeground).toBe('#ffffff');
    expect(Math.abs(oklch(hex(mid.primary))[2] - oklch(hex('#2b62ef'))[2])).toBeLessThan(3);
  });

  it.each(['light', 'dark'] as const)(
    "the screen's own accent (%s) passes the accent's checks itself",
    (tone) => {
      const own = OWN_TOKENS[tone];
      const accent = hex(OWN_ACCENT[tone]);
      const text = tone === 'light' ? hex('#ffffff') : hex('#000000');
      expect(contrast(text, accent)).toBeGreaterThanOrEqual(SCREEN_TEXT_CONTRAST);
      for (const on of [own.background, own.card, own.muted])
        expect(contrast(accent, hex(on))).toBeGreaterThanOrEqual(SCREEN_GRAPHIC_CONTRAST);
    },
  );

  it('a picture under a strong veil keeps the theme; under a light one it does not', () => {
    const picture = (opacity: number): ThemeValues => ({
      ...BUILTIN_THEME_VALUES.night,
      background: {
        color: '#000000',
        textTone: 'light',
        image: '/themes/x.svg',
        mode: 'cover',
        veil: { color: '#000000', opacity },
      },
    });
    const strong = screenPaletteOf(picture(0.9));
    expect(strong.source).toBe('theme');
    expect(strong.style.backgroundImage).toContain('url("/themes/x.svg")');
    expectReadable(strong, backgroundExtremes(picture(0.9).background));
    expect(screenPaletteOf(picture(0.35)).source).toBe('screen');
  });

  it('without a theme: the screen’s own light tokens', () => {
    const p = screenPaletteOf(null);
    expect(p.source).toBe('screen');
    expect(p.tone).toBe('light');
    expectReadable(p, [hex('#ffffff'), hex('#ffffff')]);
  });
});
