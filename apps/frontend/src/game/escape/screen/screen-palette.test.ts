import {
  BUILTIN_THEME_VALUES,
  type ThemeValues,
  backgroundExtremes,
  contrast,
  parseHex,
  worstContrast,
} from '@quiz-dock/contracts';
import { describe, expect, it } from 'vitest';
import {
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
      '--background': '#0f172a',
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
    expect(screenPaletteOf(BUILTIN_THEME_VALUES['high-contrast']).tokens.primary).toBe('#ffe14d');
    // Classic's blue under white text is 5.2:1: darkened, same hue.
    const classic = screenPaletteOf(BUILTIN_THEME_VALUES.classic).tokens;
    expect(classic.primary).not.toBe(BUILTIN_THEME_VALUES.classic.accent);
    expect(classic.primaryForeground).toBe('#ffffff');
  });

  it('without a theme: the screen’s own light tokens', () => {
    const p = screenPaletteOf(null);
    expect(p.source).toBe('screen');
    expect(p.tone).toBe('light');
    expectReadable(p, [hex('#ffffff'), hex('#ffffff')]);
  });
});
