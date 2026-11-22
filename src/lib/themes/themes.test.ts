// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeMocks = vi.hoisted(() => ({
  isNative: false,
  setStyle: vi.fn<(options: { style: string }) => Promise<void>>(async () => undefined),
  setBackgroundColor: vi.fn<(options: { color: string }) => Promise<void>>(async () => undefined),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => nativeMocks.isNative,
  },
}));

vi.mock('@capacitor/status-bar', () => ({
  Style: {
    Dark: 'DARK',
    Light: 'LIGHT',
    Default: 'DEFAULT',
  },
  StatusBar: {
    setStyle: nativeMocks.setStyle,
    setBackgroundColor: nativeMocks.setBackgroundColor,
  },
}));

import { createReaderNativeFeatures } from '../native/reader-native-features';
import {
  BOOT_THEME_STORAGE_KEY,
  bootstrapBootTheme,
  clearBootThemeCache,
  cssColorToHex,
  mirrorBootThemePreferences,
  readBootThemeCache,
  skeletonThemes,
  syncShellAppearanceChrome,
  themeSwatches,
  themeTokens,
  writeBootThemeCache,
} from './themes';

const repoRoot = process.cwd();

function parseCssCustomProperties(css: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const match of css.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/gi)) {
    vars[match[1]!] = match[2]!.replace(/\s+/g, ' ').trim();
  }
  return vars;
}

function resolveCssVar(
  value: string | undefined,
  vars: Record<string, string>,
): string | undefined {
  if (!value) return value;
  const match = value.match(/^var\((--[a-z0-9-]+)\)$/i);
  return match ? resolveCssVar(vars[match[1]!], vars) : value;
}

beforeEach(() => {
  nativeMocks.isNative = false;
  nativeMocks.setStyle.mockClear();
  nativeMocks.setBackgroundColor.mockClear();
  window.localStorage.clear();
  document.documentElement.className = '';
  document.documentElement.removeAttribute('style');
  document.documentElement.dataset.theme = 'fennec';
  document.documentElement.dataset.mode = 'dark';
  document.head.innerHTML = '<meta name="theme-color" content="" />';
  document.body.innerHTML = '<div id="app"></div>';
  document.body.removeAttribute('style');
});

describe('static theme tokens and CSS parity', () => {
  it('includes all 23 palettes with exact swatch and surface parity against theme CSS files', () => {
    expect(skeletonThemes).toHaveLength(23);

    for (const theme of skeletonThemes) {
      const cssPath =
        theme === 'eink'
          ? join(repoRoot, 'src/lib/themes/eink.css')
          : join(repoRoot, 'node_modules/@skeletonlabs/skeleton/src/themes', `${theme}.css`);
      const vars = parseCssCustomProperties(readFileSync(cssPath, 'utf8'));

      expect(themeSwatches[theme], `swatch parity for ${theme}`).toMatchObject({
        primary: resolveCssVar(vars['--color-primary-500'], vars),
        secondary: resolveCssVar(vars['--color-secondary-500'], vars),
        tertiary: resolveCssVar(vars['--color-tertiary-500'], vars),
      });

      expect(themeTokens[theme], `surface parity for ${theme}`).toEqual({
        primary: resolveCssVar(vars['--color-primary-500'], vars),
        secondary: resolveCssVar(vars['--color-secondary-500'], vars),
        tertiary: resolveCssVar(vars['--color-tertiary-500'], vars),
        rootBgLight: resolveCssVar(vars['--color-root-bg-light'], vars),
        rootBgDark: resolveCssVar(vars['--color-root-bg-dark'], vars),
        surfaceLight: resolveCssVar(vars['--color-surface-50'], vars),
        surfaceDark: resolveCssVar(vars['--color-surface-950'], vars),
      });
    }
  });

  it('converts hex, rgb, oklch, oklab, and lab theme surface colors to 6-digit hex for StatusBar', () => {
    expect(cssColorToHex('#fff')).toBe('#ffffff');
    expect(cssColorToHex('#1a2b3cff')).toBe('#1a2b3c');
    expect(cssColorToHex('rgb(255, 128, 0)')).toBe('#ff8000');
    expect(cssColorToHex('oklch(1 0 0 / 1)')).toBe('#ffffff');
    expect(cssColorToHex('oklch(0 0 0)')).toBe('#000000');
    expect(cssColorToHex('oklab(1 0 0)')).toBe('#ffffff');
    expect(cssColorToHex('lab(100 0 0)')).toBe('#ffffff');
    expect(cssColorToHex('lab(0 0 0)')).toBe('#000000');

    for (const theme of skeletonThemes) {
      expect(cssColorToHex(themeTokens[theme].rootBgLight)).toMatch(/^#[0-9a-f]{6}$/);
      expect(cssColorToHex(themeTokens[theme].rootBgDark)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('boot theme cache and pre-paint script', () => {
  it('keeps index.html free of inline scripts under script-src self', () => {
    const indexHtml = readFileSync(join(repoRoot, 'index.html'), 'utf8');
    expect(indexHtml).toContain("script-src 'self'");
    const scriptTags = [...indexHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scriptTags.length).toBeGreaterThanOrEqual(2);
    for (const [, attrs, inlineBody] of scriptTags) {
      expect(attrs).toMatch(/\bsrc=/i);
      expect(inlineBody?.trim()).toBe('');
    }
  });

  it('applies cached Light eink theme and surface colors in public/boot-theme.js before first paint', () => {
    writeBootThemeCache('eink', 'light');
    const bootScript = readFileSync(join(repoRoot, 'public/boot-theme.js'), 'utf8');
    new Function(bootScript)();

    expect(document.documentElement.dataset.theme).toBe('eink');
    expect(document.documentElement.dataset.mode).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--color-root-bg-light')).toBe(
      'oklch(1 0 0)',
    );
    expect(document.documentElement.style.getPropertyValue('--color-surface-50')).toBe(
      'oklch(1 0 0)',
    );
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe(
      'oklch(1 0 0)',
    );
  });

  it('mirrors partial preference updates and clears the cache on reset', () => {
    mirrorBootThemePreferences(new Map([['uiMode', 'light']]));
    expect(readBootThemeCache()).toMatchObject({
      theme: 'fennec',
      mode: 'light',
      rootBgLight: themeTokens.fennec.rootBgLight,
    });

    mirrorBootThemePreferences(new Map([['uiTheme', 'eink']]));
    expect(readBootThemeCache()).toMatchObject({
      theme: 'eink',
      mode: 'light',
      rootBgLight: 'oklch(1 0 0)',
      rootBgDark: 'oklch(0 0 0)',
    });

    clearBootThemeCache();
    expect(window.localStorage.getItem(BOOT_THEME_STORAGE_KEY)).toBeNull();
    expect(readBootThemeCache()).toBeNull();
  });

  it('loads the cached theme before mount and falls back cleanly to fennec on error', async () => {
    writeBootThemeCache('eink', 'light');
    let attributesDuringLoad: { theme: string | undefined; mode: string | undefined } | null = null;

    const resolved = await bootstrapBootTheme(async (requested) => {
      attributesDuringLoad = {
        theme: document.documentElement.dataset.theme,
        mode: document.documentElement.dataset.mode,
      };
      expect(requested).toBe('eink');
      expect(document.documentElement.style.getPropertyValue('--color-root-bg-light')).toBe(
        'oklch(1 0 0)',
      );
      return true;
    });

    expect(attributesDuringLoad).toEqual({ theme: 'eink', mode: 'light' });
    expect(resolved).toEqual({ theme: 'eink', mode: 'light' });
    expect(document.documentElement.dataset.theme).toBe('eink');
    expect(document.documentElement.dataset.mode).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--color-root-bg-light')).toBe('');

    writeBootThemeCache('cerberus', 'light');
    const fallback = await bootstrapBootTheme(async () => {
      throw new Error('chunk failed');
    });

    expect(fallback).toEqual({ theme: 'fennec', mode: 'light' });
    expect(document.documentElement.dataset.theme).toBe('fennec');
    expect(document.documentElement.dataset.mode).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--color-root-bg-light')).toBe('');
  });
});

describe('reactive browser theme-color and native StatusBar synchronization', () => {
  it('updates meta[name="theme-color"] from document.body and syncs native StatusBar outside reader mode', async () => {
    nativeMocks.isNative = true;
    document.body.style.backgroundColor = 'rgb(255, 255, 255)';

    syncShellAppearanceChrome('eink', 'light');

    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    expect(meta?.content).toBe('rgb(255, 255, 255)');
    await vi.waitFor(() => {
      expect(nativeMocks.setStyle).toHaveBeenCalledWith({ style: 'LIGHT' });
      expect(nativeMocks.setBackgroundColor).toHaveBeenCalledWith({ color: '#ffffff' });
    });

    nativeMocks.setStyle.mockClear();
    nativeMocks.setBackgroundColor.mockClear();
    document.body.style.backgroundColor = 'rgb(18, 20, 28)';

    syncShellAppearanceChrome('fennec', 'dark');

    expect(meta?.content).toBe('rgb(18, 20, 28)');
    await vi.waitFor(() => {
      expect(nativeMocks.setStyle).toHaveBeenCalledWith({ style: 'DARK' });
      expect(nativeMocks.setBackgroundColor).toHaveBeenCalledWith({ color: '#12141c' });
    });
  });

  it('skips status bar mutations during reader mode and serializes after reader teardown', async () => {
    nativeMocks.isNative = true;
    const order: string[] = [];
    nativeMocks.setStyle.mockImplementation(async ({ style }: { style: string }) => {
      order.push(`style:${style}`);
    });
    nativeMocks.setBackgroundColor.mockImplementation(async ({ color }: { color: string }) => {
      order.push(`bg:${color}`);
    });

    let releaseShow!: () => void;
    const readerFeatures = createReaderNativeFeatures({
      hideStatusBar: async () => void order.push('reader:hide'),
      showStatusBar: () =>
        new Promise<void>((resolve) => {
          releaseShow = () => {
            order.push('reader:show');
            resolve();
          };
        }),
      setReaderChrome: async (enabled) => void order.push(`reader:chrome:${enabled}`),
      setVolumeButtons: async () => undefined,
      setKeepAwake: async () => undefined,
    });

    await readerFeatures.enable(false);
    order.length = 0;

    syncShellAppearanceChrome('eink', 'light', { readerActive: true });
    await Promise.resolve();
    expect(nativeMocks.setStyle).not.toHaveBeenCalled();

    const disabling = readerFeatures.disable();
    document.body.style.backgroundColor = 'rgb(255, 255, 255)';
    syncShellAppearanceChrome('eink', 'light', { readerActive: false });

    await vi.waitFor(() => expect(releaseShow).toBeTypeOf('function'));
    expect(order).toEqual([]);
    releaseShow();
    await disabling;
    await vi.waitFor(() => {
      expect(order).toEqual(['reader:show', 'reader:chrome:false', 'style:LIGHT', 'bg:#ffffff']);
    });
  });
});

describe('normalized base typography and 200% text scaling rules', () => {
  it('shares the root font stack and inherits base font sizing across app.css and eink.css', () => {
    const appCss = readFileSync(join(repoRoot, 'src/app.css'), 'utf8');
    const einkCss = readFileSync(join(repoRoot, 'src/lib/themes/eink.css'), 'utf8');

    expect(appCss).toContain(
      "--turnleaf-font-sans: 'Avenir Next', Avenir, 'Segoe UI', sans-serif;",
    );
    expect(appCss).toMatch(
      /html\[data-theme\]\s*\{[\s\S]*?--typo-base--font-family:\s*var\(--turnleaf-font-sans\);/,
    );
    expect(appCss).toMatch(/html\[data-theme\]\s*\{[\s\S]*?--typo-base--font-size:\s*inherit;/);
    expect(appCss).toMatch(/html\[data-theme\]\s*\{[\s\S]*?--typo-base--line-height:\s*inherit;/);
    expect(appCss).toMatch(
      /body\s*\{[\s\S]*?font-family:\s*inherit;[\s\S]*?font-size:\s*inherit;[\s\S]*?line-height:\s*inherit;/,
    );
    expect(appCss).toMatch(/button,\s*input\s*\{\s*font:\s*inherit;\s*\}/);
    expect(appCss).not.toMatch(/body\s*\{[^}]*font-size:\s*\d+px/);

    const einkVars = parseCssCustomProperties(einkCss);
    expect(einkVars['--typo-base--font-family']).toBe(
      "'Avenir Next', Avenir, 'Segoe UI', sans-serif",
    );
    expect(einkVars['--typo-base--font-size']).toBe('inherit');
    expect(einkVars['--typo-base--line-height']).toBe('inherit');
  });
});
