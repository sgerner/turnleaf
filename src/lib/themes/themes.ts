import { Capacitor, type SystemBarsStyle } from '@capacitor/core';
import { enqueueNativeWindowAction } from '../native/reader-native-features';
import {
  applySystemBarsStyle,
  applyThemeColorMeta,
  systemBarsStyleForHex,
} from '../native/system-bars';

const themeStyles = {
  catppuccin: () => import('@skeletonlabs/skeleton/themes/catppuccin'),
  cerberus: () => import('@skeletonlabs/skeleton/themes/cerberus'),
  concord: () => import('@skeletonlabs/skeleton/themes/concord'),
  crimson: () => import('@skeletonlabs/skeleton/themes/crimson'),
  eink: () => import('./eink.css'),
  fennec: null,
  hamlindigo: () => import('@skeletonlabs/skeleton/themes/hamlindigo'),
  legacy: () => import('@skeletonlabs/skeleton/themes/legacy'),
  mint: () => import('@skeletonlabs/skeleton/themes/mint'),
  modern: () => import('@skeletonlabs/skeleton/themes/modern'),
  mona: () => import('@skeletonlabs/skeleton/themes/mona'),
  nosh: () => import('@skeletonlabs/skeleton/themes/nosh'),
  nouveau: () => import('@skeletonlabs/skeleton/themes/nouveau'),
  pine: () => import('@skeletonlabs/skeleton/themes/pine'),
  reign: () => import('@skeletonlabs/skeleton/themes/reign'),
  rocket: () => import('@skeletonlabs/skeleton/themes/rocket'),
  rose: () => import('@skeletonlabs/skeleton/themes/rose'),
  sahara: () => import('@skeletonlabs/skeleton/themes/sahara'),
  seafoam: () => import('@skeletonlabs/skeleton/themes/seafoam'),
  terminus: () => import('@skeletonlabs/skeleton/themes/terminus'),
  vintage: () => import('@skeletonlabs/skeleton/themes/vintage'),
  vox: () => import('@skeletonlabs/skeleton/themes/vox'),
  wintry: () => import('@skeletonlabs/skeleton/themes/wintry'),
} as const;

export type SkeletonTheme = keyof typeof themeStyles;
export type UiMode = 'light' | 'dark';

export interface ThemeSwatch {
  readonly primary: string;
  readonly secondary: string;
  readonly tertiary: string;
}

export interface ThemeSurfaceTokens {
  readonly rootBgLight: string;
  readonly rootBgDark: string;
  readonly surfaceLight: string;
  readonly surfaceDark: string;
}

export interface ThemeMetadata extends ThemeSwatch, ThemeSurfaceTokens {}

export interface BootThemeCache extends ThemeSurfaceTokens {
  readonly theme: SkeletonTheme;
  readonly mode: UiMode;
}

export const BOOT_THEME_STORAGE_KEY = 'turnleaf_boot_theme_v1';
export const DEFAULT_THEME: SkeletonTheme = 'fennec';
export const DEFAULT_MODE: UiMode = 'dark';

export const skeletonThemes = Object.keys(themeStyles) as SkeletonTheme[];

export const themeTokens: Readonly<Record<SkeletonTheme, ThemeMetadata>> = {
  catppuccin: {
    primary: 'oklch(66.37% 0.18 273.14deg)',
    secondary: 'oklch(72.56% 0.17 338.45deg)',
    tertiary: 'oklch(60.23% 0.1 201.09deg)',
    rootBgLight: 'oklch(1 0 0 / 1)',
    rootBgDark: 'oklch(24.29% 0.03 283.92deg)',
    surfaceLight: 'oklch(90.6% 0.01 264.54deg)',
    surfaceDark: 'oklch(24.29% 0.03 283.92deg)',
  },
  cerberus: {
    primary: 'oklch(0.57 0.21 258.29)',
    secondary: 'oklch(0.49 0.23 300.45)',
    tertiary: 'oklch(0.65 0.26 2.47)',
    rootBgLight: 'oklch(0.99 0 0)',
    rootBgDark: 'oklch(0.18 0 0)',
    surfaceLight: 'oklch(0.99 0 0)',
    surfaceDark: 'oklch(0.18 0 0)',
  },
  concord: {
    primary: 'oklch(57.74% 0.21 273.85deg)',
    secondary: 'oklch(65.34% 0.22 351.93deg)',
    tertiary: 'oklch(69.62% 0.15 247.99deg)',
    rootBgLight: 'oklch(1 0 0 / 1)',
    rootBgDark: 'oklch(29.11% 0.01 285.87deg)',
    surfaceLight: 'oklch(97.02% 0 none)',
    surfaceDark: 'oklch(23.67% 0.01 285.84deg)',
  },
  crimson: {
    primary: 'oklch(55.71% 0.21 19.55deg)',
    secondary: 'oklch(59.26% 0.09 239.95deg)',
    tertiary: 'oklch(78.4% 0.01 31.17deg)',
    rootBgLight: 'oklch(1 0 0 / 1)',
    rootBgDark: 'oklch(16.69% 0.02 275.16deg)',
    surfaceLight: 'oklch(90.65% 0 264.68deg)',
    surfaceDark: 'oklch(16.69% 0.02 275.16deg)',
  },
  eink: {
    primary: 'oklch(0.5 0 0)',
    secondary: 'oklch(0.5 0 0)',
    tertiary: 'oklch(0.5 0 0)',
    rootBgLight: 'oklch(1 0 0)',
    rootBgDark: 'oklch(0 0 0)',
    surfaceLight: 'oklch(1 0 0)',
    surfaceDark: 'oklch(0 0 0)',
  },
  fennec: {
    primary: 'oklch(65.88% 0.21 38.25deg)',
    secondary: 'oklch(87.53% 0.1 74.15deg)',
    tertiary: 'oklch(57.22% 0.05 185.36deg)',
    rootBgLight: 'oklch(80.11% 0.01 161.11deg)',
    rootBgDark: 'oklch(25.39% 0.01 279.01deg)',
    surfaceLight: 'oklch(80.11% 0.01 161.11deg)',
    surfaceDark: 'oklch(25.39% 0.01 279.01deg)',
  },
  hamlindigo: {
    primary: 'oklch(80.28% 0.08 266.51deg)',
    secondary: 'oklch(65.46% 0.07 87.04deg)',
    tertiary: 'oklch(64.32% 0.06 213.24deg)',
    rootBgLight: 'oklch(1 0 0 / 1)',
    rootBgDark: 'oklch(31.91% 0.04 266.95deg)',
    surfaceLight: 'oklch(93.75% 0.01 273.43deg)',
    surfaceDark: 'oklch(31.91% 0.04 266.95deg)',
  },
  legacy: {
    primary: 'oklch(69.84% 0.15 162.21deg)',
    secondary: 'oklch(51.06% 0.23 276.97deg)',
    tertiary: 'oklch(68.47% 0.15 237.31deg)',
    rootBgLight: 'oklch(1 0 0 / 1)',
    rootBgDark: 'oklch(27.93% 0.05 270.32deg)',
    surfaceLight: 'oklch(92.32% 0.01 279.78deg)',
    surfaceDark: 'oklch(27.93% 0.05 270.32deg)',
  },
  mint: {
    primary: 'oklch(83.57% 0.18 148.98deg)',
    secondary: 'oklch(59.27% 0.21 282.75deg)',
    tertiary: 'oklch(44.74% 0.03 322.1deg)',
    rootBgLight: 'oklch(70.51% 0.04 167.09deg)',
    rootBgDark: 'oklch(33.3% 0.04 177.78deg)',
    surfaceLight: 'oklch(89.13% 0.03 155.27deg)',
    surfaceDark: 'oklch(21.88% 0.02 186.33deg)',
  },
  modern: {
    primary: 'oklch(65.59% 0.21 354.32deg)',
    secondary: 'oklch(71.48% 0.13 215.21deg)',
    tertiary: 'oklch(70.37% 0.12 182.49deg)',
    rootBgLight: 'oklch(91.63% 0.04 285.57deg)',
    rootBgDark: 'oklch(33.59% 0.11 275.82deg)',
    surfaceLight: 'oklch(91.63% 0.04 285.57deg)',
    surfaceDark: 'oklch(33.59% 0.11 275.82deg)',
  },
  mona: {
    primary: 'oklch(56.31% 0.21 294.98deg)',
    secondary: 'oklch(63.43% 0.16 148.39deg)',
    tertiary: 'oklch(81.11% 0.1 190.5deg)',
    rootBgLight: 'oklch(1 0 0 / 1)',
    rootBgDark: 'oklch(22.88% 0.03 258.32deg)',
    surfaceLight: 'oklch(100% 0 none)',
    surfaceDark: 'oklch(22.88% 0.03 258.32deg)',
  },
  nosh: {
    primary: 'oklch(56.22% 0.23 24.62deg)',
    secondary: 'oklch(89.23% 0.04 17.93deg)',
    tertiary: 'oklch(42.89% 0.04 161.33deg)',
    rootBgLight: 'oklch(97.61% 0 none)',
    rootBgDark: 'oklch(9.69% 0 none)',
    surfaceLight: 'oklch(97.61% 0 none)',
    surfaceDark: 'oklch(9.69% 0 none)',
  },
  nouveau: {
    primary: 'oklch(83.44% 0.16 97deg)',
    secondary: 'oklch(56.7% 0.19 256.45deg)',
    tertiary: 'oklch(62.5% 0.15 284.38deg)',
    rootBgLight: 'oklch(98.18% 0.01 308.72deg)',
    rootBgDark: 'oklch(10.09% 0.05 307.48deg)',
    surfaceLight: 'oklch(98.18% 0.01 308.72deg)',
    surfaceDark: 'oklch(10.09% 0.05 307.48deg)',
  },
  pine: {
    primary: 'oklch(62.15% 0.08 79.85deg)',
    secondary: 'oklch(31.9% 0.11 347.8deg)',
    tertiary: 'oklch(61.68% 0.02 103.61deg)',
    rootBgLight: 'oklch(88.66% 0.01 121.61deg)',
    rootBgDark: 'oklch(24.33% 0.02 129.39deg)',
    surfaceLight: 'oklch(88.66% 0.01 121.61deg)',
    surfaceDark: 'oklch(24.33% 0.02 129.39deg)',
  },
  reign: {
    primary: 'oklch(94.82% 0.17 110.7deg)',
    secondary: 'oklch(94.82% 0.17 110.7deg)',
    tertiary: 'oklch(94.82% 0.17 110.7deg)',
    rootBgLight: 'oklch(84.03% 0 164.35deg)',
    rootBgDark: 'oklch(35.65% 0 286.57deg)',
    surfaceLight: 'oklch(96.24% 0 164.22deg)',
    surfaceDark: 'oklch(45.68% 0 none)',
  },
  rocket: {
    primary: 'oklch(71.48% 0.13 215.21deg)',
    secondary: 'oklch(62.31% 0.19 259.81deg)',
    tertiary: 'oklch(62.68% 0.23 303.91deg)',
    rootBgLight: 'oklch(1 0 0 / 1)',
    rootBgDark: 'oklch(33.01% 0.03 257.52deg)',
    surfaceLight: 'oklch(93.67% 0.01 264.6deg)',
    surfaceDark: 'oklch(33.01% 0.03 257.52deg)',
  },
  rose: {
    primary: 'oklch(69.89% 0.13 348.12deg)',
    secondary: 'oklch(46.75% 0.22 272.16deg)',
    tertiary: 'oklch(78.41% 0.08 291.85deg)',
    rootBgLight: 'oklch(96.76% 0.01 318.08deg)',
    rootBgDark: 'oklch(25.82% 0.01 304.87deg)',
    surfaceLight: 'oklch(96.76% 0.01 318.08deg)',
    surfaceDark: 'oklch(25.82% 0.01 304.87deg)',
  },
  sahara: {
    primary: 'oklch(78.19% 0.15 76.87deg)',
    secondary: 'oklch(76.32% 0.12 183.49deg)',
    tertiary: 'oklch(85.72% 0.12 126.76deg)',
    rootBgLight: 'oklch(94.95% 0.02 2.38deg)',
    rootBgDark: 'oklch(35.48% 0.1 13.78deg)',
    surfaceLight: 'oklch(94.95% 0.02 2.38deg)',
    surfaceDark: 'oklch(35.48% 0.1 13.78deg)',
  },
  seafoam: {
    primary: 'oklch(80.78% 0.07 190.34deg)',
    secondary: 'oklch(32.36% 0.07 262.2deg)',
    tertiary: 'oklch(65.36% 0.23 34.04deg)',
    rootBgLight: 'oklch(93.2% 0.04 209.05deg)',
    rootBgDark: 'oklch(35.4% 0.05 234.87deg)',
    surfaceLight: 'oklch(93.2% 0.04 209.05deg)',
    surfaceDark: 'oklch(35.4% 0.05 234.87deg)',
  },
  terminus: {
    primary: 'oklch(48.65% 0.3 279.02deg)',
    secondary: 'oklch(89.36% 0.16 171.7deg)',
    tertiary: 'oklch(91.3% 0.21 117.7deg)',
    rootBgLight: 'oklch(99.11% 0 none)',
    rootBgDark: 'oklch(18.67% 0 none)',
    surfaceLight: 'oklch(99.11% 0 none)',
    surfaceDark: 'oklch(18.67% 0 none)',
  },
  vintage: {
    primary: 'oklch(71.39% 0.16 59.66deg)',
    secondary: 'oklch(80.21% 0.08 152.14deg)',
    tertiary: 'oklch(71.48% 0.13 215.21deg)',
    rootBgLight: 'oklch(91.65% 0 78.25deg)',
    rootBgDark: 'oklch(19.49% 0.01 59.11deg)',
    surfaceLight: 'oklch(91.65% 0 78.25deg)',
    surfaceDark: 'oklch(19.49% 0.01 59.11deg)',
  },
  vox: {
    primary: 'oklch(82.71% 0.1 51.5deg)',
    secondary: 'oklch(92.54% 0.17 123.36deg)',
    tertiary: 'oklch(80.24% 0.12 298.53deg)',
    rootBgLight: 'oklch(92.52% 0.03 294.62deg)',
    rootBgDark: 'oklch(32.44% 0.07 302.21deg)',
    surfaceLight: 'oklch(92.52% 0.03 294.62deg)',
    surfaceDark: 'oklch(32.44% 0.07 302.21deg)',
  },
  wintry: {
    primary: 'oklch(62.31% 0.19 259.81deg)',
    secondary: 'oklch(68.47% 0.15 237.31deg)',
    tertiary: 'oklch(66.28% 0.18 280.87deg)',
    rootBgLight: 'oklch(1 0 0 / 1)',
    rootBgDark: 'oklch(18.53% 0.04 263.67deg)',
    surfaceLight: 'oklch(97.59% 0 264.7deg)',
    surfaceDark: 'oklch(18.53% 0.04 263.67deg)',
  },
};

export const themeSwatches: Readonly<Record<SkeletonTheme, ThemeSwatch>> = themeTokens;

export function isSkeletonTheme(theme: string): theme is SkeletonTheme {
  return Object.hasOwn(themeStyles, theme);
}

export function normalizeUiMode(mode: string | null | undefined): UiMode {
  return mode === 'light' ? 'light' : 'dark';
}

export async function loadTheme(theme: string): Promise<boolean> {
  if (!isSkeletonTheme(theme)) return false;
  await themeStyles[theme]?.();
  return true;
}

export function getThemeRootBackground(theme: string, mode: UiMode): string {
  const tokens = themeTokens[isSkeletonTheme(theme) ? theme : DEFAULT_THEME];
  return mode === 'light' ? tokens.rootBgLight : tokens.rootBgDark;
}

export function readBootThemeCache(): BootThemeCache | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(BOOT_THEME_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BootThemeCache>;
    if (typeof parsed.theme !== 'string' || !isSkeletonTheme(parsed.theme)) return null;
    if (parsed.mode !== 'light' && parsed.mode !== 'dark') return null;
    const defaults = themeTokens[parsed.theme];
    return {
      theme: parsed.theme,
      mode: parsed.mode,
      rootBgLight:
        typeof parsed.rootBgLight === 'string' && parsed.rootBgLight
          ? parsed.rootBgLight
          : defaults.rootBgLight,
      rootBgDark:
        typeof parsed.rootBgDark === 'string' && parsed.rootBgDark
          ? parsed.rootBgDark
          : defaults.rootBgDark,
      surfaceLight:
        typeof parsed.surfaceLight === 'string' && parsed.surfaceLight
          ? parsed.surfaceLight
          : defaults.surfaceLight,
      surfaceDark:
        typeof parsed.surfaceDark === 'string' && parsed.surfaceDark
          ? parsed.surfaceDark
          : defaults.surfaceDark,
    };
  } catch {
    return null;
  }
}

export function writeBootThemeCache(theme: string, mode: UiMode): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const resolvedTheme = isSkeletonTheme(theme) ? theme : DEFAULT_THEME;
  const resolvedMode = normalizeUiMode(mode);
  const surfaces = themeTokens[resolvedTheme];
  const payload: BootThemeCache = {
    theme: resolvedTheme,
    mode: resolvedMode,
    rootBgLight: surfaces.rootBgLight,
    rootBgDark: surfaces.rootBgDark,
    surfaceLight: surfaces.surfaceLight,
    surfaceDark: surfaces.surfaceDark,
  };
  try {
    window.localStorage.setItem(BOOT_THEME_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Boot cache is an optional startup optimization and must not block persistence.
  }
}

export function mirrorBootThemePreferences(
  preferences: ReadonlyMap<string, string>,
  fallback?: { theme?: string | undefined; mode?: string | undefined },
): void {
  if (!preferences.has('uiTheme') && !preferences.has('uiMode')) return;
  const cached = readBootThemeCache();
  const nextTheme = preferences.get('uiTheme') ?? cached?.theme ?? fallback?.theme ?? DEFAULT_THEME;
  const nextMode = normalizeUiMode(
    preferences.get('uiMode') ?? cached?.mode ?? fallback?.mode ?? DEFAULT_MODE,
  );
  writeBootThemeCache(nextTheme, nextMode);
}

export function clearBootThemeCache(): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.removeItem(BOOT_THEME_STORAGE_KEY);
  } catch {
    // Ignore storage cleanup failures in restricted environments.
  }
}

export function applyCachedBootTheme(): { theme: SkeletonTheme; mode: UiMode } {
  const cached = readBootThemeCache();
  const theme = cached?.theme ?? DEFAULT_THEME;
  const mode = cached?.mode ?? DEFAULT_MODE;

  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.mode = mode;

    if (cached) {
      const activeSurface = mode === 'light' ? cached.rootBgLight : cached.rootBgDark;
      root.style.colorScheme = mode;
      root.style.setProperty('--color-root-bg-light', cached.rootBgLight);
      root.style.setProperty('--color-root-bg-dark', cached.rootBgDark);
      root.style.setProperty('--color-surface-50', cached.surfaceLight);
      root.style.setProperty('--color-surface-950', cached.surfaceDark);
      root.style.backgroundColor = activeSurface;

      const themeColorMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
      if (themeColorMeta) themeColorMeta.content = activeSurface;
    }
  }

  return { theme, mode };
}

export function clearBootSurfaceOverrides(): void {
  if (typeof document === 'undefined') return;
  const style = document.documentElement.style;
  style.removeProperty('--color-root-bg-light');
  style.removeProperty('--color-root-bg-dark');
  style.removeProperty('--color-surface-50');
  style.removeProperty('--color-surface-950');
  style.removeProperty('background-color');
  style.removeProperty('color-scheme');
}

export async function bootstrapBootTheme(
  loader: (theme: string) => Promise<boolean> = loadTheme,
): Promise<{ theme: SkeletonTheme; mode: UiMode }> {
  const { theme: requestedTheme, mode } = applyCachedBootTheme();
  let resolvedTheme: SkeletonTheme = DEFAULT_THEME;
  try {
    if (await loader(requestedTheme)) {
      resolvedTheme = requestedTheme;
    }
  } catch {
    resolvedTheme = DEFAULT_THEME;
  }

  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.mode = mode;
    clearBootSurfaceOverrides();
  }

  return { theme: resolvedTheme, mode };
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function formatHex(r: number, g: number, b: number): string {
  return `#${clampByte(r).toString(16).padStart(2, '0')}${clampByte(g).toString(16).padStart(2, '0')}${clampByte(b).toString(16).padStart(2, '0')}`;
}

function parseHueDegrees(token: string): number | null {
  if (token === 'none') return 0;
  const match = token.match(/^([+-]?(?:\d+\.?\d*|\.\d+))(deg|rad|turn|grad)?$/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = (match[2] ?? 'deg').toLowerCase();
  if (unit === 'rad') return (value * 180) / Math.PI;
  if (unit === 'turn') return value * 360;
  if (unit === 'grad') return value * 0.9;
  return value;
}

function linearToSrgbByte(channel: number): number {
  const clamped = Math.max(0, Math.min(1, channel));
  const gamma = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  return clampByte(gamma * 255);
}

function oklabToHex(L: number, a: number, b: number): string {
  const clampedL = Math.max(0, Math.min(1, L));
  const lPrime = clampedL + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = clampedL - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = clampedL - 0.0894841775 * a - 1.291485548 * b;

  const l = lPrime * lPrime * lPrime;
  const m = mPrime * mPrime * mPrime;
  const s = sPrime * sPrime * sPrime;

  const rLinear = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gLinear = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLinear = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  return formatHex(linearToSrgbByte(rLinear), linearToSrgbByte(gLinear), linearToSrgbByte(bLinear));
}

export function cssColorToHex(input: string): string | null {
  const value = input.trim().toLowerCase();
  if (!value) return null;

  const hexMatch = value.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (hexMatch) {
    const hex = hexMatch[1]!;
    if (hex.length === 3 || hex.length === 4) {
      return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
    }
    return `#${hex.slice(0, 6)}`;
  }

  const rgbMatch = value.match(/^rgba?\(\s*([^)]+)\s*\)$/);
  if (rgbMatch) {
    const [channelsPart] = rgbMatch[1]!.split('/');
    const parts = (channelsPart ?? '')
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean);
    if (parts.length < 3) return null;
    const rgb = parts.slice(0, 3).map((part) => {
      if (part === 'none') return 0;
      if (part.endsWith('%')) return (Number(part.slice(0, -1)) / 100) * 255;
      return Number(part);
    });
    if (rgb.some((channel) => Number.isNaN(channel))) return null;
    return formatHex(rgb[0]!, rgb[1]!, rgb[2]!);
  }

  const oklchMatch = value.match(/^oklch\(\s*([^)]+)\s*\)$/);
  if (oklchMatch) {
    const [coordsPart] = oklchMatch[1]!.split('/');
    const parts = (coordsPart ?? '').trim().split(/\s+/).filter(Boolean);
    if (parts.length < 3) return null;
    const [rawL, rawC, rawH] = parts as [string, string, string];
    const lightness =
      rawL === 'none' ? 0 : rawL.endsWith('%') ? Number(rawL.slice(0, -1)) / 100 : Number(rawL);
    const chroma =
      rawC === 'none'
        ? 0
        : rawC.endsWith('%')
          ? (Number(rawC.slice(0, -1)) * 0.4) / 100
          : Number(rawC);
    const hueDegrees = parseHueDegrees(rawH);
    if (Number.isNaN(lightness) || Number.isNaN(chroma) || hueDegrees === null) return null;

    const C = Math.max(0, chroma);
    const hueRad = (hueDegrees * Math.PI) / 180;
    return oklabToHex(lightness, C * Math.cos(hueRad), C * Math.sin(hueRad));
  }

  const oklabMatch = value.match(/^oklab\(\s*([^)]+)\s*\)$/);
  if (oklabMatch) {
    const [coordsPart] = oklabMatch[1]!.split('/');
    const parts = (coordsPart ?? '').trim().split(/\s+/).filter(Boolean);
    if (parts.length < 3) return null;
    const [rawL, rawA, rawB] = parts as [string, string, string];
    const L =
      rawL === 'none' ? 0 : rawL.endsWith('%') ? Number(rawL.slice(0, -1)) / 100 : Number(rawL);
    const a =
      rawA === 'none'
        ? 0
        : rawA.endsWith('%')
          ? (Number(rawA.slice(0, -1)) * 0.4) / 100
          : Number(rawA);
    const b =
      rawB === 'none'
        ? 0
        : rawB.endsWith('%')
          ? (Number(rawB.slice(0, -1)) * 0.4) / 100
          : Number(rawB);
    if (Number.isNaN(L) || Number.isNaN(a) || Number.isNaN(b)) return null;
    return oklabToHex(L, a, b);
  }

  const labMatch = value.match(/^lab\(\s*([^)]+)\s*\)$/);
  if (labMatch) {
    const [coordsPart] = labMatch[1]!.split('/');
    const parts = (coordsPart ?? '').trim().split(/\s+/).filter(Boolean);
    if (parts.length < 3) return null;
    const [rawL, rawA, rawB] = parts as [string, string, string];
    const L = rawL === 'none' ? 0 : rawL.endsWith('%') ? Number(rawL.slice(0, -1)) : Number(rawL);
    const a =
      rawA === 'none'
        ? 0
        : rawA.endsWith('%')
          ? (Number(rawA.slice(0, -1)) * 125) / 100
          : Number(rawA);
    const b =
      rawB === 'none'
        ? 0
        : rawB.endsWith('%')
          ? (Number(rawB.slice(0, -1)) * 125) / 100
          : Number(rawB);
    if (Number.isNaN(L) || Number.isNaN(a) || Number.isNaN(b)) return null;

    const kappa = 24389 / 27;
    const epsilon = 216 / 24389;
    const fy = (L + 16) / 116;
    const fx = a / 500 + fy;
    const fz = fy - b / 200;
    const x50 = (fx * fx * fx > epsilon ? fx * fx * fx : (116 * fx - 16) / kappa) * 0.9642956764;
    const y50 = L > kappa * epsilon ? fy * fy * fy : L / kappa;
    const z50 = (fz * fz * fz > epsilon ? fz * fz * fz : (116 * fz - 16) / kappa) * 0.8251046025;

    const rLinear = +3.1341359569958707 * x50 - 1.6173863321612538 * y50 - 0.4906619460083532 * z50;
    const gLinear = -0.978795502912089 * x50 + 1.916254567259524 * y50 + 0.03344273116131949 * z50;
    const bLinear = +0.07195537988411677 * x50 - 0.2289768264158322 * y50 + 1.405386058324125 * z50;

    return formatHex(
      linearToSrgbByte(rLinear),
      linearToSrgbByte(gLinear),
      linearToSrgbByte(bLinear),
    );
  }

  return null;
}

function isUsableCssColor(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    Boolean(normalized) &&
    normalized !== 'transparent' &&
    normalized !== 'rgba(0, 0, 0, 0)' &&
    normalized !== 'rgb(0 0 0 / 0)'
  );
}

function hasNativeSystemBarsBridge(): boolean {
  if (Capacitor.isNativePlatform()) return true;
  const cap = (globalThis as { Capacitor?: { PluginHeaders?: ReadonlyArray<{ name?: string }> } })
    .Capacitor;
  return Boolean(cap?.PluginHeaders?.some((header) => header.name === 'SystemBars'));
}

export function resolveShellAppearanceChrome(
  theme: string,
  mode: UiMode,
): { metaColor: string; hexColor: string; style: SystemBarsStyle; luminance: number } {
  const fallbackColor = getThemeRootBackground(theme, mode);
  let resolvedColor = fallbackColor;

  if (typeof document !== 'undefined') {
    const bodyColor = document.body ? getComputedStyle(document.body).backgroundColor : '';
    if (isUsableCssColor(bodyColor)) {
      resolvedColor = bodyColor;
    }
  }

  const fallbackHex = cssColorToHex(fallbackColor) ?? (mode === 'light' ? '#ffffff' : '#212227');
  const hexColor = cssColorToHex(resolvedColor) ?? fallbackHex;
  const { style, luminance } = systemBarsStyleForHex(hexColor, mode);

  return {
    metaColor: resolvedColor,
    hexColor,
    style,
    luminance,
  };
}

export function resolveReaderAppearanceChrome(
  theme: string,
  mode: UiMode,
  readerElement?: Element | null,
): { hexColor: string; style: SystemBarsStyle; luminance: number } {
  const tokens = isSkeletonTheme(theme) ? themeTokens[theme] : themeTokens[DEFAULT_THEME];
  const fallbackColor = mode === 'dark' ? tokens.surfaceDark : tokens.surfaceLight;
  const fallbackHex = cssColorToHex(fallbackColor) ?? (mode === 'light' ? '#ffffff' : '#212227');
  const elementColor = readerElement ? getComputedStyle(readerElement).backgroundColor : '';
  const hexColor =
    (isUsableCssColor(elementColor) ? cssColorToHex(elementColor) : null) ?? fallbackHex;
  const { style, luminance } = systemBarsStyleForHex(hexColor, mode);

  return { hexColor, style, luminance };
}

let shellChromeGeneration = 0;

export function syncShellAppearanceChrome(
  theme: string,
  mode: UiMode,
  options?: { readerActive?: boolean | undefined },
): void {
  const generation = ++shellChromeGeneration;
  if (options?.readerActive) return;

  const { metaColor, style } = resolveShellAppearanceChrome(theme, mode);

  if (typeof document !== 'undefined') {
    applyThemeColorMeta(metaColor, document);
  }

  if (!hasNativeSystemBarsBridge()) return;

  void enqueueNativeWindowAction(async () => {
    if (generation !== shellChromeGeneration) return;
    await applySystemBarsStyle(style);
  });
}
