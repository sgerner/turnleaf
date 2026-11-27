// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DatabaseModule from '../database/database';
import type * as ThemesModule from '../themes/themes';

const mocks = vi.hoisted(() => ({
  loadTheme: vi.fn<(theme: string) => Promise<boolean>>(async () => true),
  setPreference: vi.fn<(key: string, value: string) => Promise<void>>(async () => undefined),
  getPreferences: vi.fn(async () => new Map<string, string>()),
  getBooks: vi.fn(async () => []),
  getSyncStatus: vi.fn(async () => ({
    pendingCount: 0,
    failedCount: 0,
    lastError: null,
    lastUpdatedAt: null,
  })),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => 'web',
  },
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => ({ connected: false, connectionType: 'none' })),
    addListener: vi.fn(async () => ({ remove: async () => undefined })),
  },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: async () => undefined })),
    exitApp: vi.fn(async () => undefined),
  },
}));

vi.mock('../themes/themes', async (importOriginal) => {
  const actual = await importOriginal<typeof ThemesModule>();
  return {
    ...actual,
    loadTheme: mocks.loadTheme,
  };
});

vi.mock('../database/database', async (importOriginal) => {
  const actual = await importOriginal<typeof DatabaseModule>();
  return {
    ...actual,
    getPreferences: mocks.getPreferences,
    getBooks: mocks.getBooks,
    getSyncStatus: mocks.getSyncStatus,
    setPreference: mocks.setPreference,
  };
});

import Library from './Library.svelte';
import { skeletonThemes } from '../themes/themes';

const server = {
  id: 'server-1',
  displayName: 'Kavita Test',
  baseUrl: 'https://books.example.com',
  credentialRef: 'cred-1',
  kavitaVersion: '0.8.0',
  lastConnectedAt: '2026-01-01T00:00:00.000Z',
};

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
  mocks.loadTheme.mockReset();
  mocks.loadTheme.mockResolvedValue(true);
  mocks.setPreference.mockReset();
  mocks.setPreference.mockResolvedValue(undefined);
  mocks.getPreferences.mockReset();
  mocks.getPreferences.mockResolvedValue(new Map());
  mocks.getBooks.mockReset();
  mocks.getBooks.mockResolvedValue([]);
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

describe('Library Settings appearance and palette switching', () => {
  it('initializes pendingTheme from the active theme and renders all 23 static swatches without bulk preloading', async () => {
    let resolvePrefs!: (value: Map<string, string>) => void;
    mocks.getPreferences.mockImplementationOnce(
      () =>
        new Promise<Map<string, string>>((resolve) => {
          resolvePrefs = resolve;
        }),
    );

    instance = mount(Library, {
      target,
      props: {
        server,
        apiKey: 'test-key',
        theme: 'eink',
        mode: 'light',
        onThemeChange: vi.fn(),
        onModeChange: vi.fn(),
        onApiKeyChange: vi.fn(),
        onServerDeleted: vi.fn(),
        onChangeServerAddress: vi.fn(),
      },
    });
    flushSync();

    const settingsButton = target.querySelector<HTMLButtonElement>(
      'button[aria-label="Open settings"]',
    )!;
    expect(settingsButton).toBeTruthy();
    settingsButton.click();
    await vi.waitFor(() => {
      expect(target.querySelector('[role="group"][aria-label="Theme palette"]')).toBeTruthy();
    });
    flushSync();

    expect(mocks.loadTheme).not.toHaveBeenCalled();

    const paletteGroup = target.querySelector('[role="group"][aria-label="Theme palette"]');
    expect(paletteGroup).toBeTruthy();
    const swatchButtons = paletteGroup!.querySelectorAll<HTMLButtonElement>('button');
    expect(swatchButtons).toHaveLength(skeletonThemes.length);

    for (const button of swatchButtons) {
      const colorBars = button.querySelectorAll<HTMLSpanElement>(':scope > span > span');
      expect(colorBars).toHaveLength(3);
      for (const bar of colorBars) {
        expect(bar.getAttribute('style')).toContain('background-color:');
        expect(bar.getAttribute('style')).not.toContain('var(--color-');
      }
    }

    const einkButton = paletteGroup!.querySelector<HTMLButtonElement>(
      'button[aria-label="Use eink theme"]',
    );
    const vintageButton = paletteGroup!.querySelector<HTMLButtonElement>(
      'button[aria-label="Use vintage theme"]',
    );
    expect(einkButton?.getAttribute('aria-pressed')).toBe('true');
    expect(vintageButton?.getAttribute('aria-pressed')).toBe('false');

    resolvePrefs(new Map());
    await Promise.resolve();
  });

  it('orders concurrent updateTheme taps so newer selections win over late completions', async () => {
    let finishSlowCerberus!: (value: boolean) => void;
    mocks.loadTheme.mockImplementation((next) => {
      if (next === 'cerberus') {
        return new Promise<boolean>((resolve) => {
          finishSlowCerberus = resolve;
        });
      }
      return Promise.resolve(true);
    });

    const onThemeChange = vi.fn();
    instance = mount(Library, {
      target,
      props: {
        server,
        apiKey: 'test-key',
        theme: 'fennec',
        mode: 'dark',
        onThemeChange,
        onModeChange: vi.fn(),
        onApiKeyChange: vi.fn(),
        onServerDeleted: vi.fn(),
        onChangeServerAddress: vi.fn(),
      },
    });
    flushSync();

    const settingsButton = target.querySelector<HTMLButtonElement>(
      'button[aria-label="Open settings"]',
    )!;
    settingsButton.click();
    await vi.waitFor(() => {
      expect(target.querySelector('button[aria-label="Use cerberus theme"]')).toBeTruthy();
    });
    flushSync();

    const cerberusBtn = target.querySelector<HTMLButtonElement>(
      'button[aria-label="Use cerberus theme"]',
    )!;
    const einkBtn = target.querySelector<HTMLButtonElement>('button[aria-label="Use eink theme"]')!;

    cerberusBtn.click();
    einkBtn.click();

    await vi.waitFor(() => {
      expect(onThemeChange).toHaveBeenCalledExactlyOnceWith('eink');
      expect(mocks.setPreference).toHaveBeenCalledExactlyOnceWith('uiTheme', 'eink');
    });
    flushSync();
    expect(einkBtn.getAttribute('aria-pressed')).toBe('true');

    finishSlowCerberus(true);
    await Promise.resolve();
    await Promise.resolve();
    flushSync();

    expect(onThemeChange).toHaveBeenCalledExactlyOnceWith('eink');
    expect(mocks.setPreference).toHaveBeenCalledExactlyOnceWith('uiTheme', 'eink');
    expect(einkBtn.getAttribute('aria-pressed')).toBe('true');
    expect(cerberusBtn.getAttribute('aria-pressed')).toBe('false');
  });

  it('renders theme load errors inside Appearance, keeps #replacement-api-key valid, and clears on next valid tap', async () => {
    mocks.loadTheme.mockImplementation(async (next) => {
      if (next === 'crimson') throw new Error('chunk network error');
      return true;
    });

    instance = mount(Library, {
      target,
      props: {
        server,
        apiKey: 'test-key',
        theme: 'fennec',
        mode: 'dark',
        onThemeChange: vi.fn(),
        onModeChange: vi.fn(),
        onApiKeyChange: vi.fn(),
        onServerDeleted: vi.fn(),
        onChangeServerAddress: vi.fn(),
      },
    });
    flushSync();

    const settingsButton = target.querySelector<HTMLButtonElement>(
      'button[aria-label="Open settings"]',
    )!;
    settingsButton.click();
    await vi.waitFor(() => {
      expect(
        target.querySelector('section[aria-labelledby="library-settings-appearance-title"]'),
      ).toBeTruthy();
    });
    flushSync();

    const appearanceSection = target.querySelector(
      'section[aria-labelledby="library-settings-appearance-title"]',
    )!;
    const replacementKeyInput = target.querySelector<HTMLInputElement>('#replacement-api-key')!;
    const crimsonBtn = target.querySelector<HTMLButtonElement>(
      'button[aria-label="Use crimson theme"]',
    )!;
    const einkBtn = target.querySelector<HTMLButtonElement>('button[aria-label="Use eink theme"]')!;

    crimsonBtn.click();
    await vi.waitFor(() => {
      const alert = appearanceSection.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('The theme could not load. Try again.');
    });

    expect(replacementKeyInput.getAttribute('aria-invalid')).toBeNull();
    expect(target.querySelector('#settings-key-error')?.textContent?.trim()).toBe('');

    einkBtn.click();
    await vi.waitFor(() => {
      expect(appearanceSection.querySelector('[role="alert"]')).toBeNull();
      expect(einkBtn.getAttribute('aria-pressed')).toBe('true');
    });
    expect(replacementKeyInput.getAttribute('aria-invalid')).toBeNull();
  });

  it('ignores late failures from superseded theme imports', async () => {
    let rejectSlowCrimson!: (error: Error) => void;
    mocks.loadTheme.mockImplementation((next) => {
      if (next === 'crimson') {
        return new Promise<boolean>((_, reject) => {
          rejectSlowCrimson = reject;
        });
      }
      return Promise.resolve(true);
    });

    instance = mount(Library, {
      target,
      props: {
        server,
        apiKey: 'test-key',
        theme: 'fennec',
        mode: 'dark',
        onThemeChange: vi.fn(),
        onModeChange: vi.fn(),
        onApiKeyChange: vi.fn(),
        onServerDeleted: vi.fn(),
        onChangeServerAddress: vi.fn(),
      },
    });
    flushSync();

    target.querySelector<HTMLButtonElement>('button[aria-label="Open settings"]')!.click();
    await vi.waitFor(() => {
      expect(
        target.querySelector('section[aria-labelledby="library-settings-appearance-title"]'),
      ).toBeTruthy();
    });
    flushSync();

    const appearanceSection = target.querySelector(
      'section[aria-labelledby="library-settings-appearance-title"]',
    )!;
    const crimsonBtn = target.querySelector<HTMLButtonElement>(
      'button[aria-label="Use crimson theme"]',
    )!;
    const einkBtn = target.querySelector<HTMLButtonElement>('button[aria-label="Use eink theme"]')!;

    crimsonBtn.click();
    einkBtn.click();

    await vi.waitFor(() => {
      expect(einkBtn.getAttribute('aria-pressed')).toBe('true');
    });

    rejectSlowCrimson(new Error('late network error'));
    await Promise.resolve();
    await Promise.resolve();
    flushSync();

    expect(appearanceSection.querySelector('[role="alert"]')).toBeNull();
    expect(einkBtn.getAttribute('aria-pressed')).toBe('true');
  });
});
