import * as CapacitorCore from '@capacitor/core';
import type { SystemBarsStyle, SystemBarsVisibilityOptions } from '@capacitor/core';
import { enqueueNativeOperation } from './reader-native-features';

const LIGHT_SYSTEM_BARS_STYLE = 'LIGHT' as SystemBarsStyle;
const DARK_SYSTEM_BARS_STYLE = 'DARK' as SystemBarsStyle;

export type SurfaceMode = 'light' | 'dark';

export interface ResolvedSystemBars {
  style: SystemBarsStyle;
  themeColor: string;
  luminance: number;
}

interface LinearRgb {
  r: number;
  g: number;
  b: number;
}

// Equal-contrast crossover between white (Y = 1) and black (Y = 0) icons under WCAG 2.2:
// sqrt(1.05 * 0.05) - 0.05 ≈ 0.1791, yielding >= 4.58:1 contrast on both sides (well above 3:1).
export const WCAG_ICON_LUMINANCE_THRESHOLD = Math.sqrt(1.05 * 0.05) - 0.05;

const DEFAULT_LIGHT_HEX = '#ffffff';
const DEFAULT_DARK_HEX = '#212227';

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function srgbToLinear(channel: number): number {
  const c = clamp01(channel);
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  const c = clamp01(channel);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

function linearRgbToHex({ r, g, b }: LinearRgb): string {
  return (
    '#' +
    [r, g, b]
      .map((channel) =>
        Math.round(linearToSrgb(channel) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

function oklabToLinearRgb(L: number, a: number, b: number): LinearRgb {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  return {
    r: clamp01(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: clamp01(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: clamp01(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

function cieLabToLinearRgb(L: number, a: number, b: number): LinearRgb {
  const kappa = 24389 / 27;
  const epsilon = 216 / 24389;
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;

  const xr = fx ** 3 > epsilon ? fx ** 3 : (116 * fx - 16) / kappa;
  const yr = L > kappa * epsilon ? ((L + 16) / 116) ** 3 : L / kappa;
  const zr = fz ** 3 > epsilon ? fz ** 3 : (116 * fz - 16) / kappa;

  const x50 = xr * (0.3457 / 0.3585);
  const y50 = yr;
  const z50 = zr * ((1 - 0.3457 - 0.3585) / 0.3585);

  return {
    r: clamp01(3.134135957 * x50 - 1.6173863322 * y50 - 0.490661946 * z50),
    g: clamp01(-0.9787955029 * x50 + 1.9162545673 * y50 + 0.0334427312 * z50),
    b: clamp01(0.0719553799 * x50 - 0.2289768264 * y50 + 1.4053860583 * z50),
  };
}

function parseNumberOrPercent(token: string, percentScale = 1): number | null {
  if (token === 'none') return 0;
  if (token.endsWith('%')) {
    const num = Number.parseFloat(token.slice(0, -1));
    return Number.isFinite(num) ? (num / 100) * percentScale : null;
  }
  const num = Number.parseFloat(token);
  return Number.isFinite(num) ? num : null;
}

function parseHueRadians(token: string): number | null {
  if (token === 'none') return 0;
  if (token.endsWith('rad')) {
    const v = Number.parseFloat(token.slice(0, -3));
    return Number.isFinite(v) ? v : null;
  }
  if (token.endsWith('turn')) {
    const v = Number.parseFloat(token.slice(0, -4));
    return Number.isFinite(v) ? v * 2 * Math.PI : null;
  }
  if (token.endsWith('grad')) {
    const v = Number.parseFloat(token.slice(0, -4));
    return Number.isFinite(v) ? (v * Math.PI) / 200 : null;
  }
  const deg = Number.parseFloat(token.endsWith('deg') ? token.slice(0, -3) : token);
  return Number.isFinite(deg) ? (deg * Math.PI) / 180 : null;
}

function parseAlpha(token: string | undefined): number {
  if (!token) return 1;
  const trimmed = token.trim();
  if (!trimmed || trimmed === 'none') return 0;
  const value = parseNumberOrPercent(trimmed, 1);
  return value === null ? 1 : clamp01(value);
}

export function parseCssColorToLinearRgb(raw: string): LinearRgb | null {
  const input = raw.trim().toLowerCase();
  if (!input || input === 'transparent' || input === 'none') return null;

  if (input.startsWith('#')) {
    const hex = input.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = Number.parseInt(hex[0]! + hex[0]!, 16);
      const g = Number.parseInt(hex[1]! + hex[1]!, 16);
      const b = Number.parseInt(hex[2]! + hex[2]!, 16);
      const a = hex.length === 4 ? Number.parseInt(hex[3]! + hex[3]!, 16) / 255 : 1;
      if ([r, g, b, a].some(Number.isNaN) || a === 0) return null;
      return {
        r: srgbToLinear(r / 255),
        g: srgbToLinear(g / 255),
        b: srgbToLinear(b / 255),
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
      if ([r, g, b, a].some(Number.isNaN) || a === 0) return null;
      return {
        r: srgbToLinear(r / 255),
        g: srgbToLinear(g / 255),
        b: srgbToLinear(b / 255),
      };
    }
    return null;
  }

  const fnMatch = input.match(/^([a-z]+)\((.+)\)$/);
  if (!fnMatch) return null;
  const [, fn, body] = fnMatch;
  if (!fn || !body) return null;

  const [colorPart, alphaPart] = body.split('/');
  if (!colorPart) return null;

  if (fn === 'rgb' || fn === 'rgba') {
    const parts = colorPart
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean);
    if (parts.length < 3) return null;
    const alpha = alphaPart !== undefined ? parseAlpha(alphaPart) : parseAlpha(parts[3]);
    if (alpha === 0) return null;
    const r = parseNumberOrPercent(parts[0]!, 255);
    const g = parseNumberOrPercent(parts[1]!, 255);
    const b = parseNumberOrPercent(parts[2]!, 255);
    if (r === null || g === null || b === null) return null;
    return {
      r: srgbToLinear(r / 255),
      g: srgbToLinear(g / 255),
      b: srgbToLinear(b / 255),
    };
  }

  if (fn === 'color') {
    const parts = colorPart.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 4 || (parts[0] !== 'srgb' && parts[0] !== 'srgb-linear')) return null;
    if (parseAlpha(alphaPart) === 0) return null;
    const r = parseNumberOrPercent(parts[1]!, 1);
    const g = parseNumberOrPercent(parts[2]!, 1);
    const b = parseNumberOrPercent(parts[3]!, 1);
    if (r === null || g === null || b === null) return null;
    if (parts[0] === 'srgb-linear') {
      return { r: clamp01(r), g: clamp01(g), b: clamp01(b) };
    }
    return { r: srgbToLinear(r), g: srgbToLinear(g), b: srgbToLinear(b) };
  }

  if (fn === 'oklch') {
    const parts = colorPart.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 3 || parseAlpha(alphaPart) === 0) return null;
    const L = parseNumberOrPercent(parts[0]!, 1);
    const C = parseNumberOrPercent(parts[1]!, 0.4);
    const h = parseHueRadians(parts[2]!);
    if (L === null || C === null || h === null) return null;
    return oklabToLinearRgb(clamp01(L), C * Math.cos(h), C * Math.sin(h));
  }

  if (fn === 'oklab') {
    const parts = colorPart.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 3 || parseAlpha(alphaPart) === 0) return null;
    const L = parseNumberOrPercent(parts[0]!, 1);
    const a = parseNumberOrPercent(parts[1]!, 0.4);
    const b = parseNumberOrPercent(parts[2]!, 0.4);
    if (L === null || a === null || b === null) return null;
    return oklabToLinearRgb(clamp01(L), a, b);
  }

  if (fn === 'lab') {
    const parts = colorPart.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 3 || parseAlpha(alphaPart) === 0) return null;
    const L = parseNumberOrPercent(parts[0]!, 100);
    const a = parseNumberOrPercent(parts[1]!, 125);
    const b = parseNumberOrPercent(parts[2]!, 125);
    if (L === null || a === null || b === null) return null;
    return cieLabToLinearRgb(Math.max(0, Math.min(100, L)), a, b);
  }

  if (fn === 'lch') {
    const parts = colorPart.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 3 || parseAlpha(alphaPart) === 0) return null;
    const L = parseNumberOrPercent(parts[0]!, 100);
    const C = parseNumberOrPercent(parts[1]!, 150);
    const h = parseHueRadians(parts[2]!);
    if (L === null || C === null || h === null) return null;
    return cieLabToLinearRgb(Math.max(0, Math.min(100, L)), C * Math.cos(h), C * Math.sin(h));
  }

  return null;
}

export function relativeLuminance({ r, g, b }: LinearRgb): number {
  return 0.2126 * clamp01(r) + 0.7152 * clamp01(g) + 0.0722 * clamp01(b);
}

export function wcagContrastRatio(luminanceA: number, luminanceB: number): number {
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

export function systemBarsStyleForLuminance(luminance: number): SystemBarsStyle {
  return luminance > WCAG_ICON_LUMINANCE_THRESHOLD
    ? LIGHT_SYSTEM_BARS_STYLE
    : DARK_SYSTEM_BARS_STYLE;
}

export function resolveSystemBarsFromColor(
  cssColor: string,
  fallbackMode: SurfaceMode,
): ResolvedSystemBars {
  const parsed = parseCssColorToLinearRgb(cssColor);
  if (parsed) {
    const luminance = relativeLuminance(parsed);
    return {
      style: systemBarsStyleForLuminance(luminance),
      themeColor: linearRgbToHex(parsed),
      luminance,
    };
  }
  return fallbackMode === 'light'
    ? { style: LIGHT_SYSTEM_BARS_STYLE, themeColor: DEFAULT_LIGHT_HEX, luminance: 1 }
    : { style: DARK_SYSTEM_BARS_STYLE, themeColor: DEFAULT_DARK_HEX, luminance: 0.0163 };
}

function resolveCssCustomProperty(
  computed: CSSStyleDeclaration,
  propertyName: string,
  depth = 0,
): string {
  if (depth > 4) return '';
  const raw = computed.getPropertyValue(propertyName).trim();
  if (!raw) return '';
  const varMatch = raw.match(/^var\(\s*(--[\w-]+)(?:\s*,\s*(.+))?\)$/);
  if (varMatch?.[1]) {
    const nested = resolveCssCustomProperty(computed, varMatch[1], depth + 1);
    if (nested) return nested;
    return varMatch[2]?.trim() ?? '';
  }
  return raw;
}

export function resolveShellSystemBars(
  mode: SurfaceMode,
  doc: Document = document,
): ResolvedSystemBars {
  const rootStyle = getComputedStyle(doc.documentElement);
  const rootToken = resolveCssCustomProperty(
    rootStyle,
    mode === 'light' ? '--color-root-bg-light' : '--color-root-bg-dark',
  );
  if (parseCssColorToLinearRgb(rootToken)) {
    return resolveSystemBarsFromColor(rootToken, mode);
  }

  const surfaceToken = resolveCssCustomProperty(
    rootStyle,
    mode === 'light' ? '--color-surface-50' : '--color-surface-950',
  );
  if (parseCssColorToLinearRgb(surfaceToken)) {
    return resolveSystemBarsFromColor(surfaceToken, mode);
  }

  const bodyBg = doc.body ? getComputedStyle(doc.body).backgroundColor : '';
  return resolveSystemBarsFromColor(bodyBg, mode);
}

export function resolveReaderSystemBars(
  mode: SurfaceMode,
  readerElement?: Element | null,
  doc: Document = document,
): ResolvedSystemBars {
  if (readerElement) {
    const readerBg = getComputedStyle(readerElement).backgroundColor;
    if (parseCssColorToLinearRgb(readerBg)) {
      return resolveSystemBarsFromColor(readerBg, mode);
    }
  }

  const rootStyle = getComputedStyle(doc.documentElement);
  const surfaceToken = resolveCssCustomProperty(
    rootStyle,
    mode === 'light' ? '--color-surface-50' : '--color-surface-950',
  );
  return resolveSystemBarsFromColor(surfaceToken, mode);
}

export function applyThemeColorMeta(themeColor: string, doc: Document = document): void {
  let meta = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta && doc.head) {
    meta = doc.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    doc.head.appendChild(meta);
  }
  meta?.setAttribute('content', themeColor);
}

function getSystemBarsPlugin(): typeof CapacitorCore.SystemBars | null {
  try {
    return CapacitorCore.SystemBars ?? null;
  } catch {
    return null;
  }
}

export async function applySystemBarsStyle(style: SystemBarsStyle): Promise<void> {
  try {
    await getSystemBarsPlugin()?.setStyle?.({ style });
  } catch {
    // Native bar styling is optional and must not interrupt app rendering.
  }
}

export async function hideSystemBars(
  options: SystemBarsVisibilityOptions = { animation: 'NONE' },
): Promise<void> {
  await getSystemBarsPlugin()?.hide?.(options);
}

export async function showSystemBars(
  options: SystemBarsVisibilityOptions = { animation: 'NONE' },
): Promise<void> {
  await getSystemBarsPlugin()?.show?.(options);
}

export function syncShellSystemBars(mode: SurfaceMode, doc: Document = document): Promise<void> {
  const resolved = resolveShellSystemBars(mode, doc);
  applyThemeColorMeta(resolved.themeColor, doc);
  return enqueueNativeOperation(() => applySystemBarsStyle(resolved.style));
}
