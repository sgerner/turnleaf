// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DatabaseModule from './lib/database/database';
import type * as ThemesModule from './lib/themes/themes';

const mocks = vi.hoisted(() => ({
  isNative: true,
  loadTheme: vi.fn<(theme: string) => Promise<boolean>>(async () => true),
  getServer: vi.fn(async () => null),
  getPreferences: vi.fn(async () => new Map<string, string>()),
  resetLocalDatabase: vi.fn(async () => undefined),
  setStyle: vi.fn(async () => undefined),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => mocks.isNative,
    getPlatform: () => (mocks.isNative ? 'android' : 'web'),
  },
  SystemBars: {
    setStyle: mocks.setStyle,
  },
  SystemBarsStyle: {
    Dark: 'DARK',
    Light: 'LIGHT',
    Default: 'DEFAULT',
  },
}));

vi.mock('./lib/github/releases', () => ({
  fetchLatestGithubRelease: vi.fn(async () => null),
}));

vi.mock('./lib/themes/themes', async (importOriginal) => {
  const actual = await importOriginal<typeof ThemesModule>();
  return {
    ...actual,
    loadTheme: mocks.loadTheme,
  };
});

vi.mock('./lib/database/database', async (importOriginal) => {
  const actual = await importOriginal<typeof DatabaseModule>();
  return {
    ...actual,
    getServer: mocks.getServer,
    getPreferences: mocks.getPreferences,
    resetLocalDatabase: mocks.resetLocalDatabase,
  };
});

import App from './App.svelte';
import { writeBootThemeCache } from './lib/themes/themes';

let target: HTMLDivElement;
let instance: Record<string, unknown> | null = null;

beforeEach(() => {
  if (!Element.prototype.animate) {
    Element.prototype.animate = () =>
      ({
        cancel() {},
        finish() {},
        onfinish: null,
      }) as unknown as Animation;
  }
  mocks.isNative = true;
  mocks.loadTheme.mockReset();
  mocks.loadTheme.mockResolvedValue(true);
  mocks.getServer.mockReset();
  mocks.getServer.mockResolvedValue(null);
  mocks.getPreferences.mockReset();
  mocks.getPreferences.mockResolvedValue(new Map());
  mocks.setStyle.mockClear();
  window.localStorage.clear();
  document.documentElement.dataset.theme = 'fennec';
  document.documentElement.dataset.mode = 'dark';
  document.head.innerHTML = '<meta name="theme-color" content="" />';
  target = document.createElement('div');
  document.body.innerHTML = '';
  document.body.append(target);
});

afterEach(() => {
  if (instance) {
    unmount(instance);
    instance = null;
  }
});

describe('App cold boot appearance and reconciliation', () => {
  it('renders cached Light eink during startup splash before SQLite resolves and reconciles preferences', async () => {
    writeBootThemeCache('eink', 'light');
    let resolvePreferences!: (value: Map<string, string>) => void;
    mocks.getPreferences.mockImplementationOnce(
      () =>
        new Promise<Map<string, string>>((resolve) => {
          resolvePreferences = resolve;
        }),
    );

    instance = mount(App, { target });
    flushSync();

    expect(target.textContent).toContain('Opening your library...');
    expect(document.documentElement.dataset.theme).toBe('eink');
    expect(document.documentElement.dataset.mode).toBe('light');
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe(
      'oklch(1 0 0)',
    );
    await vi.waitFor(() => {
      expect(mocks.setStyle).toHaveBeenCalledWith({ style: 'LIGHT' });
    });

    resolvePreferences(
      new Map([
        ['uiTheme', 'vintage'],
        ['uiMode', 'dark'],
      ]),
    );

    await vi.waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('vintage');
      expect(document.documentElement.dataset.mode).toBe('dark');
    });
    await vi.waitFor(() => {
      expect(mocks.setStyle).toHaveBeenCalledWith({ style: 'DARK' });
    });
  });

  it('falls back cleanly to fennec when reconciled loadTheme fails', async () => {
    writeBootThemeCache('eink', 'light');
    mocks.loadTheme.mockRejectedValueOnce(new Error('missing theme chunk'));
    mocks.getPreferences.mockResolvedValueOnce(
      new Map([
        ['uiTheme', 'eink'],
        ['uiMode', 'light'],
      ]),
    );

    instance = mount(App, { target });
    flushSync();

    await vi.waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('fennec');
      expect(document.documentElement.dataset.mode).toBe('light');
    });
  });
});
