import {
  BLACK,
  type Rgb,
  type ThemeValues,
  WHITE,
  backgroundExtremes,
  blend,
  contrast,
  fromOklch,
  oklch,
  parseHex,
  toHex,
  worstContrast,
} from '@quiz-dock/contracts';
import type { CSSProperties } from 'react';
import { gradientCss } from '../../surface';

/**
 * The big screen's colours (M6 §1.8): read from the back of a room, so every text
 * reaches 7:1 on what it sits on, twice the usual 4.5:1. The theme's background is
 * drawn when the screen's text, muted and warning colours reach 7:1 on all of it
 * (`backgroundExtremes`, `worstContrast`); a picture never does (it may hold any
 * colour), nor a background too mid-grey for either tone. Such a theme falls back
 * to the screen's own plain tokens, in the theme's tone. The accent keeps its hue,
 * its lightness moved until the text on it reads at 7:1 and it stands out (3:1).
 */

/** Text on the screen: WCAG AAA, for distance. */
export const SCREEN_TEXT_CONTRAST = 7;
/** Shapes that carry meaning (a stage's fill, an edge): WCAG 1.4.11. */
export const SCREEN_GRAPHIC_CONTRAST = 3;

export type ScreenTone = 'light' | 'dark';

/** The screen's own tokens, each pair checked at 7:1 (text) or 3:1 (edges) in tests. */
export interface ScreenTokens {
  background: string;
  foreground: string;
  /** Lanes, cards and banners: opaque, so their text never depends on the background. */
  card: string;
  cardForeground: string;
  /** A stage still ahead, the PIN's plate. */
  muted: string;
  mutedForeground: string;
  /** The final minutes' clock and words: the warning colour. */
  destructive: string;
  border: string;
  primary: string;
  primaryForeground: string;
}

/** Light text tone: dark text on a light screen. Dark: the other way round. */
export const OWN_TOKENS: Record<ScreenTone, Omit<ScreenTokens, 'primary' | 'primaryForeground'>> = {
  light: {
    background: '#ffffff',
    foreground: '#0a0a0a',
    card: '#ffffff',
    cardForeground: '#0a0a0a',
    muted: '#ececec',
    mutedForeground: '#404040',
    destructive: '#9b0018',
    border: '#8a8a8a',
  },
  dark: {
    background: '#0a0a0a',
    foreground: '#fafafa',
    card: '#1a1a1a',
    cardForeground: '#fafafa',
    muted: '#2e2e2e',
    mutedForeground: '#c4c4c4',
    destructive: '#ff8a8a',
    border: '#7a7a7a',
  },
};

/** The screen's accent when the theme gives none. */
const OWN_ACCENT: Record<ScreenTone, string> = { light: '#1e40af', dark: '#7cc4ff' };

export interface ScreenPalette {
  /** `theme`: the theme's background is drawn; `screen`: the screen's own plain one. */
  source: 'theme' | 'screen';
  tone: ScreenTone;
  tokens: ScreenTokens;
  /** The token overrides and the background, for the screen's root element. */
  style: CSSProperties;
}

/** The theme's text tone as the screen's: light text means a dark screen. */
const toneOf = (theme: ThemeValues | null | undefined): ScreenTone =>
  theme?.background.textTone === 'light' ? 'dark' : 'light';

/**
 * `color` with its OKLCH lightness moved `toward` black or white, the least that makes
 * `ok` true; null when even the end does not.
 */
function shifted(color: Rgb, toward: 'darker' | 'lighter', ok: (c: Rgb) => boolean): Rgb | null {
  if (ok(color)) return color;
  const [L, C, h] = oklch(color);
  for (let i = 1; i <= 100; i++) {
    const l = toward === 'darker' ? L - (L * i) / 100 : L + ((1 - L) * i) / 100;
    // Checked as drawn: a hex colour, rounded.
    const c = parseHex(toHex(fromOklch([l, C, h])));
    if (ok(c)) return c;
  }
  return null;
}

/** The accent and the text on it, readable on the tokens given. */
function accentOf(
  accent: string,
  tone: ScreenTone,
  base: Omit<ScreenTokens, 'primary' | 'primaryForeground'>,
  extremes: [Rgb, Rgb],
) {
  const text = tone === 'light' ? WHITE : BLACK;
  const card = parseHex(base.card);
  const muted = parseHex(base.muted);
  const ok = (c: Rgb) =>
    contrast(text, c) >= SCREEN_TEXT_CONTRAST &&
    worstContrast(c, extremes) >= SCREEN_GRAPHIC_CONTRAST &&
    contrast(c, card) >= SCREEN_GRAPHIC_CONTRAST &&
    contrast(c, muted) >= SCREEN_GRAPHIC_CONTRAST;
  const picked =
    shifted(parseHex(accent), tone === 'light' ? 'darker' : 'lighter', ok) ??
    parseHex(OWN_ACCENT[tone]);
  return { primary: toHex(picked), primaryForeground: toHex(text) };
}

/** Whether `color` reads at 7:1 on the whole background and on the opaque surfaces. */
function readsOn(color: Rgb, extremes: [Rgb, Rgb], surfaces: Rgb[]): boolean {
  return (
    worstContrast(color, extremes) >= SCREEN_TEXT_CONTRAST &&
    surfaces.every((s) => contrast(color, s) >= SCREEN_TEXT_CONTRAST)
  );
}

/**
 * The theme's background with the screen's tokens tuned to it, or null when its text
 * cannot reach 7:1 there. Muted text is the most muted step between the tone's muted
 * grey and its text that still reads; the warning moves its lightness the same way.
 */
function themed(theme: ThemeValues, tone: ScreenTone): ScreenTokens | null {
  if (theme.background.image) return null;
  const own = OWN_TOKENS[tone];
  const extremes = backgroundExtremes(theme.background);
  const fg = parseHex(own.foreground);
  if (worstContrast(fg, extremes) < SCREEN_TEXT_CONTRAST) return null;
  const surfaces = [parseHex(own.card), parseHex(own.muted)];
  let muted: Rgb | null = null;
  for (let i = 10; i >= 0 && !muted; i--) {
    const c = blend(parseHex(own.mutedForeground), fg, i / 10);
    if (readsOn(c, extremes, surfaces)) muted = c;
  }
  const warning = shifted(parseHex(own.destructive), tone === 'light' ? 'darker' : 'lighter', (c) =>
    readsOn(c, extremes, [parseHex(own.card)]),
  );
  if (!muted || !warning) return null;
  const base = {
    ...own,
    background: theme.background.color,
    mutedForeground: toHex(muted),
    destructive: toHex(warning),
  };
  return { ...base, ...accentOf(theme.accent, tone, base, extremes) };
}

function ownTokens(theme: ThemeValues | null | undefined, tone: ScreenTone): ScreenTokens {
  const own = OWN_TOKENS[tone];
  const bg = parseHex(own.background);
  return { ...own, ...accentOf(theme?.accent ?? OWN_ACCENT[tone], tone, own, [bg, bg]) };
}

/** The screen's palette for a room's theme (none: the screen's own, light). */
export function screenPaletteOf(theme: ThemeValues | null | undefined): ScreenPalette {
  const tone = toneOf(theme);
  const fromTheme = theme ? themed(theme, tone) : null;
  const tokens = fromTheme ?? ownTokens(theme, tone);
  const gradient = fromTheme && theme?.background.gradient;
  const style: Record<string, string> = {
    colorScheme: tone,
    '--background': tokens.background,
    '--foreground': tokens.foreground,
    '--card': tokens.card,
    '--card-foreground': tokens.cardForeground,
    '--popover': tokens.card,
    '--popover-foreground': tokens.cardForeground,
    '--muted': tokens.muted,
    '--muted-foreground': tokens.mutedForeground,
    '--accent': tokens.muted,
    '--accent-foreground': tokens.foreground,
    '--secondary': tokens.muted,
    '--secondary-foreground': tokens.foreground,
    '--destructive': tokens.destructive,
    '--border': tokens.border,
    '--input': tokens.border,
    '--primary': tokens.primary,
    '--primary-foreground': tokens.primaryForeground,
    '--ring': tokens.primary,
  };
  if (gradient) style.backgroundImage = gradientCss(gradient);
  return {
    source: fromTheme ? 'theme' : 'screen',
    tone,
    tokens,
    style: style as CSSProperties,
  };
}
