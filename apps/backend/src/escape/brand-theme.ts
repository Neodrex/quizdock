/**
 * A licence brand as a quizdock theme (M7 §1.9). Pure: a shipped theme with the
 * brand's accent and, when it reads well, its background colour.
 */
import {
  BLACK,
  BUILTIN_THEME_VALUES,
  type BuiltinTheme,
  contrast,
  DEFAULT_THEME,
  mergeTheme,
  parseHex,
  themeAccessibility,
  type ThemeValues,
  WHITE,
} from '@quiz-dock/contracts';
import type { LicenceBrand } from './licences/licence.port';

export type BrandColours = Pick<LicenceBrand, 'accent' | 'background'> & {
  baseTheme?: BuiltinTheme;
};

/** The checks a theme fails. */
const failed = (theme: ThemeValues) =>
  new Set(
    themeAccessibility(theme)
      .checks.filter((c) => !c.passed)
      .map((c) => c.code),
  );

/**
 * The accent always stays (the escape screen moves its lightness to 7:1). The
 * background is dropped when it fails a check the accent-only theme passes.
 */
export function brandThemeOf(brand: BrandColours): ThemeValues {
  const base = BUILTIN_THEME_VALUES[brand.baseTheme ?? DEFAULT_THEME];
  const accented = mergeTheme(base, { accent: brand.accent });
  if (!brand.background) return accented;
  const rgb = parseHex(brand.background);
  const textTone = contrast(WHITE, rgb) >= contrast(BLACK, rgb) ? 'light' : 'dark';
  const coloured = mergeTheme(accented, { background: { color: brand.background, textTone } });
  const before = failed(accented);
  for (const code of failed(coloured)) if (!before.has(code)) return accented;
  return coloured;
}
