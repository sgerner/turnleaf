// @vitest-environment jsdom

import { SystemBarsStyle } from '@capacitor/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeMocks = vi.hoisted(() => ({
  isNative: true,
  setStyle: vi.fn(async (_options: { style: SystemBarsStyle }): Promise<void> => undefined),
  hide: vi.fn(async (): Promise<void> => undefined),
  show: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => nativeMocks.isNative,
  },
  SystemBars: {
    setStyle: nativeMocks.setStyle,
    hide: nativeMocks.hide,
    show: nativeMocks.show,
  },
  SystemBarsStyle: {
    Dark: 'DARK',
    Light: 'LIGHT',
    Default: 'DEFAULT',
  },
}));

import {
  resolveReaderAppearanceChrome,
  resolveShellAppearanceChrome,
  skeletonThemes,
  syncShellAppearanceChrome,
} from '../themes/themes';
import { createReaderNativeFeatures } from './reader-native-features';
import {
  WCAG_ICON_LUMINANCE_THRESHOLD,
  applySystemBarsStyle,
  applyThemeColorMeta,
  hexRelativeLuminance,
  systemBarsStyleForHex,
  systemBarsStyleForLuminance,
  wcagContrastRatio,
} from './system-bars';

describe('system-bars WCAG luminance and contrast', () => {
  beforeEach(() => {
    nativeMocks.isNative = true;
    nativeMocks.setStyle.mockReset();
    document.head.innerHTML = '<meta name="theme-color" content="#000000" />';
    document.body.removeAttribute('style');
  });

  it('keeps >= 3:1 icon contrast across all 23 themes (including fennec and eink) in light and dark modes', () => {
    expect(hexRelativeLuminance('#ffffff')).toBe(1);
    expect(hexRelativeLuminance('#000000')).toBe(0);
    expect(hexRelativeLuminance('invalid')).toBeNull();

    for (const theme of skeletonThemes) {
      for (const mode of ['light', 'dark'] as const) {
        const shell = resolveShellAppearanceChrome(theme, mode);
        const reader = resolveReaderAppearanceChrome(theme, mode);
        const shellIconY = shell.style === SystemBarsStyle.Light ? 0 : 1;
        const readerIconY = reader.style === SystemBarsStyle.Light ? 0 : 1;
        expect(
          wcagContrastRatio(shell.luminance, shellIconY),
          `${theme} shell ${mode}`,
        ).toBeGreaterThan(3);
        expect(
          wcagContrastRatio(reader.luminance, readerIconY),
          `${theme} reader ${mode}`,
        ).toBeGreaterThan(3);
      }
    }

    expect(resolveShellAppearanceChrome('eink', 'light').style).toBe(SystemBarsStyle.Light);
    expect(resolveShellAppearanceChrome('eink', 'dark').style).toBe(SystemBarsStyle.Dark);
    expect(resolveShellAppearanceChrome('fennec', 'light').style).toBe(SystemBarsStyle.Light);
    expect(resolveShellAppearanceChrome('fennec', 'dark').style).toBe(SystemBarsStyle.Dark);

    const justAbove = WCAG_ICON_LUMINANCE_THRESHOLD + 0.0001;
    const justBelow = WCAG_ICON_LUMINANCE_THRESHOLD - 0.0001;
    expect(systemBarsStyleForLuminance(justAbove)).toBe(SystemBarsStyle.Light);
    expect(systemBarsStyleForLuminance(justBelow)).toBe(SystemBarsStyle.Dark);
    expect(wcagContrastRatio(justAbove, 0)).toBeGreaterThan(4.5);
    expect(wcagContrastRatio(justBelow, 1)).toBeGreaterThan(4.5);
    expect(systemBarsStyleForHex(null, 'light').style).toBe(SystemBarsStyle.Light);
    expect(systemBarsStyleForHex(null, 'dark').style).toBe(SystemBarsStyle.Dark);
  });

  it('serializes SystemBars.setStyle across shell updates and reader teardown', async () => {
    const calls: string[] = [];
    nativeMocks.setStyle.mockImplementation(async ({ style }: { style: SystemBarsStyle }) => {
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
        const shell = resolveShellAppearanceChrome('eink', 'light');
        applyThemeColorMeta(shell.metaColor);
        await applySystemBarsStyle(shell.style);
      },
    });

    syncShellAppearanceChrome('eink', 'light');
    await vi.waitFor(() => expect(calls).toEqual([`system:${SystemBarsStyle.Light}`]));
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe(
      'oklch(1 0 0)',
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
