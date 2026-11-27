// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    convertFileSrc: (value: string) => value,
  },
}));

import {
  resolveReaderAppearanceChrome,
  resolveShellAppearanceChrome,
  syncShellAppearanceChrome,
} from '../themes/themes';
import { applySystemBarsStyle, hideSystemBars, showSystemBars } from './system-bars';

describe('system-bars under partial @capacitor/core mocks', () => {
  it('resolves bar styles, updates theme-color, and no-ops SystemBars calls when SystemBars exports are omitted from vi.mock', async () => {
    document.head.innerHTML = '<meta name="theme-color" content="#000000" />';
    document.body.removeAttribute('style');

    expect(resolveShellAppearanceChrome('eink', 'light')).toMatchObject({
      style: 'LIGHT',
      hexColor: '#ffffff',
      luminance: 1,
    });
    expect(resolveShellAppearanceChrome('fennec', 'dark').style).toBe('DARK');
    expect(resolveReaderAppearanceChrome('fennec', 'dark').style).toBe('DARK');

    syncShellAppearanceChrome('eink', 'light');
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe(
      'oklch(1 0 0)',
    );
    await expect(applySystemBarsStyle('LIGHT' as never)).resolves.toBeUndefined();
    await expect(hideSystemBars()).resolves.toBeUndefined();
    await expect(showSystemBars()).resolves.toBeUndefined();
  });
});
