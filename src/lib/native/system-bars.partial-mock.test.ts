// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => 'web',
    convertFileSrc: (value: string) => value,
  },
}));

import {
  hideSystemBars,
  resolveReaderSystemBars,
  resolveShellSystemBars,
  showSystemBars,
  syncShellSystemBars,
} from './system-bars';

describe('system-bars under partial @capacitor/core mocks', () => {
  it('resolves bar styles, updates theme-color, and no-ops SystemBars calls when SystemBars exports are omitted from vi.mock', async () => {
    document.head.innerHTML = '<meta name="theme-color" content="#000000" />';
    document.documentElement.removeAttribute('style');

    expect(resolveShellSystemBars('light', document)).toEqual({
      style: 'LIGHT',
      themeColor: '#ffffff',
      luminance: 1,
    });
    expect(resolveShellSystemBars('dark', document).style).toBe('DARK');
    expect(resolveReaderSystemBars('dark', null, document).style).toBe('DARK');

    await expect(syncShellSystemBars('light', document)).resolves.toBeUndefined();
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      '#ffffff',
    );
    await expect(hideSystemBars()).resolves.toBeUndefined();
    await expect(showSystemBars()).resolves.toBeUndefined();
  });
});
