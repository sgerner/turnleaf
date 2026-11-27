import * as CapacitorCore from '@capacitor/core';
import type { SystemBarsStyle, SystemBarsVisibilityOptions } from '@capacitor/core';

const LIGHT_SYSTEM_BARS_STYLE = 'LIGHT' as SystemBarsStyle;
const DARK_SYSTEM_BARS_STYLE = 'DARK' as SystemBarsStyle;

export type SurfaceMode = 'light' | 'dark';

// Equal-contrast crossover between white (Y = 1) and black (Y = 0) icons under WCAG 2.2:
// sqrt(1.05 * 0.05) - 0.05 ≈ 0.1791, yielding >= 4.58:1 contrast on both sides (well above 3:1).
export const WCAG_ICON_LUMINANCE_THRESHOLD = Math.sqrt(1.05 * 0.05) - 0.05;

function srgbByteToLinear(byte: number): number {
  const channel = Math.max(0, Math.min(255, byte)) / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

export function hexRelativeLuminance(hex: string): number | null {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const r = srgbByteToLinear(Number.parseInt(hex.slice(1, 3), 16));
  const g = srgbByteToLinear(Number.parseInt(hex.slice(3, 5), 16));
  const b = srgbByteToLinear(Number.parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
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

export function systemBarsStyleForHex(
  hex: string | null,
  fallbackMode: SurfaceMode,
): { style: SystemBarsStyle; luminance: number } {
  const luminance = hex ? hexRelativeLuminance(hex) : null;
  if (luminance !== null) {
    return { style: systemBarsStyleForLuminance(luminance), luminance };
  }
  return fallbackMode === 'light'
    ? { style: LIGHT_SYSTEM_BARS_STYLE, luminance: 1 }
    : { style: DARK_SYSTEM_BARS_STYLE, luminance: 0.0163 };
}

export function applyThemeColorMeta(themeColor: string, doc: Document = document): void {
  let meta = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta && doc.head) {
    meta = doc.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    doc.head.appendChild(meta);
  }
  if (meta) {
    meta.content = themeColor;
  }
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
