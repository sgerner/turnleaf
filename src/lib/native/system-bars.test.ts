// @vitest-environment jsdom

import { SystemBarsStyle } from '@capacitor/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const systemBarsMock = vi.hoisted(() => ({
  setStyle: vi.fn(async (_options: { style: SystemBarsStyle }): Promise<void> => undefined),
  hide: vi.fn(async (): Promise<void> => undefined),
  show: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock('@capacitor/core', () => ({
  SystemBars: systemBarsMock,
  SystemBarsStyle: {
    Dark: 'DARK',
    Light: 'LIGHT',
    Default: 'DEFAULT',
  },
}));

import { createReaderNativeFeatures } from './reader-native-features';
import {
  WCAG_ICON_LUMINANCE_THRESHOLD,
  parseCssColorToLinearRgb,
  relativeLuminance,
  resolveReaderSystemBars,
  resolveShellSystemBars,
  resolveSystemBarsFromColor,
  syncShellSystemBars,
  systemBarsStyleForLuminance,
  wcagContrastRatio,
} from './system-bars';

describe('system-bars color luminance and WCAG contrast', () => {
  beforeEach(() => {
    document.head.innerHTML = '<meta name="theme-color" content="#000000" />';
    document.documentElement.removeAttribute('style');
    systemBarsMock.setStyle.mockReset();
  });

  it('parses hex, rgb, color(srgb), oklch, and oklab CSS colors', () => {
    expect(parseCssColorToLinearRgb('#ffffff')).toEqual({ r: 1, g: 1, b: 1 });
    expect(parseCssColorToLinearRgb('#000')).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseCssColorToLinearRgb('rgb(33, 34, 39)')).not.toBeNull();
    expect(parseCssColorToLinearRgb('color(srgb 1 1 1)')).toEqual({ r: 1, g: 1, b: 1 });
    expect(parseCssColorToLinearRgb('oklch(1 0 0)')?.r).toBeCloseTo(1, 4);
    expect(parseCssColorToLinearRgb('oklch(0 0 0)')).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseCssColorToLinearRgb('oklab(0.5 0 0)')).not.toBeNull();
    expect(parseCssColorToLinearRgb('lab(100% 0 0)')?.r).toBeCloseTo(1, 3);
    expect(parseCssColorToLinearRgb('lab(0% 0 0)')).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseCssColorToLinearRgb('lch(50% 0 0)')).not.toBeNull();
    expect(parseCssColorToLinearRgb('transparent')).toBeNull();
    expect(parseCssColorToLinearRgb('rgba(255, 255, 255, 0)')).toBeNull();
  });

  it('keeps at least 3:1 icon contrast across fennec and eink light and dark surfaces', () => {
    const surfaces = [
      { name: 'fennec-light', css: 'oklch(0.98 0.005 264)', expected: SystemBarsStyle.Light },
      { name: 'fennec-dark', css: '#212227', expected: SystemBarsStyle.Dark },
      { name: 'eink-light', css: 'oklch(1 0 0)', expected: SystemBarsStyle.Light },
      { name: 'eink-dark', css: 'oklch(0 0 0)', expected: SystemBarsStyle.Dark },
    ];

    for (const surface of surfaces) {
      const resolved = resolveSystemBarsFromColor(surface.css, 'dark');
      expect(resolved.style, surface.name).toBe(surface.expected);
      const iconLuminance = resolved.style === SystemBarsStyle.Light ? 0 : 1;
      expect(wcagContrastRatio(resolved.luminance, iconLuminance), surface.name).toBeGreaterThan(3);
    }

    // Even right at the luminance crossover, icon contrast stays >= 4.58:1 (> 3:1).
    const justAbove = WCAG_ICON_LUMINANCE_THRESHOLD + 0.0001;
    const justBelow = WCAG_ICON_LUMINANCE_THRESHOLD - 0.0001;
    expect(systemBarsStyleForLuminance(justAbove)).toBe(SystemBarsStyle.Light);
    expect(systemBarsStyleForLuminance(justBelow)).toBe(SystemBarsStyle.Dark);
    expect(wcagContrastRatio(justAbove, 0)).toBeGreaterThan(4.5);
    expect(wcagContrastRatio(justBelow, 1)).toBeGreaterThan(4.5);
  });

  it('resolves nested var() surface tokens for shell and reader modes', () => {
    document.documentElement.style.setProperty('--color-surface-50', 'oklch(1 0 0)');
    document.documentElement.style.setProperty('--color-surface-950', 'oklch(0 0 0)');
    document.documentElement.style.setProperty('--color-root-bg-light', 'var(--color-surface-50)');
    document.documentElement.style.setProperty('--color-root-bg-dark', 'var(--color-surface-950)');

    const shellLight = resolveShellSystemBars('light', document);
    const shellDark = resolveShellSystemBars('dark', document);
    expect(shellLight.style).toBe(SystemBarsStyle.Light);
    expect(shellLight.themeColor).toBe('#ffffff');
    expect(shellDark.style).toBe(SystemBarsStyle.Dark);
    expect(shellDark.themeColor).toBe('#000000');

    const readerEl = document.createElement('div');
    readerEl.style.backgroundColor = 'rgb(255, 255, 255)';
    document.body.appendChild(readerEl);
    const readerLight = resolveReaderSystemBars('light', readerEl, document);
    expect(readerLight.style).toBe(SystemBarsStyle.Light);
    expect(relativeLuminance({ r: 1, g: 1, b: 1 })).toBe(1);
    readerEl.remove();
  });

  it('updates meta theme-color and serializes SystemBars.setStyle after reader teardown', async () => {
    document.documentElement.style.setProperty('--color-root-bg-light', '#ffffff');
    document.documentElement.style.setProperty('--color-root-bg-dark', '#212227');

    const calls: string[] = [];
    systemBarsMock.setStyle.mockImplementation(async ({ style }: { style: SystemBarsStyle }) => {
      calls.push(`system:${style}`);
    });

    const readerFeatures = createReaderNativeFeatures({
      hideStatusBar: async () => void calls.push('hide'),
      showStatusBar: async () => void calls.push('show'),
      setReaderChrome: async () => undefined,
      setVolumeButtons: async () => undefined,
      setKeepAwake: async () => undefined,
      setBarStyle: async (style) => void calls.push(`reader:${style}`),
      restoreBarStyle: async () => {
        const shell = resolveShellSystemBars('light', document);
        await systemBarsMock.setStyle({ style: shell.style });
      },
    });

    await syncShellSystemBars('light', document);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      '#ffffff',
    );

    await readerFeatures.enable(false);
    await readerFeatures.setBarStyle(SystemBarsStyle.Dark);
    await readerFeatures.disable();

    expect(calls).toEqual([
      `system:${SystemBarsStyle.Light}`,
      'hide',
      `reader:${SystemBarsStyle.Dark}`,
      `system:${SystemBarsStyle.Light}`,
      'show',
    ]);
  });
});
