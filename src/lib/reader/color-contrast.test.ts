import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { skeletonThemes } from '../themes/themes';
import {
  blendRgb,
  clampRgbContrast,
  computeHighlightSvgStyles,
  contrastRatio,
  parseCssColor,
  resolveReaderPalette,
} from './color-contrast';

function extractCssVariables(css: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    if (match[1] && match[2]) {
      tokens.set(match[1].trim(), match[2].trim());
    }
  }
  return tokens;
}

function loadThemeVariables(theme: string): Map<string, string> {
  const filePath =
    theme === 'eink'
      ? resolve(process.cwd(), 'src/lib/themes/eink.css')
      : resolve(process.cwd(), 'node_modules/@skeletonlabs/skeleton/src/themes', `${theme}.css`);
  return extractCssVariables(readFileSync(filePath, 'utf8'));
}

describe('color-contrast utilities', () => {
  it('parses hex, rgb, hsl, oklch, oklab, lab, and lch CSS colors', () => {
    expect(parseCssColor('#fff')).toEqual([255, 255, 255]);
    expect(parseCssColor('#111827')).toEqual([17, 24, 39]);
    expect(parseCssColor('rgb(29 78 216 / 0.8)')).toEqual([29, 78, 216]);
    expect(parseCssColor('hsl(220 90% 50%)')).toEqual([13, 89, 242]);

    const oklchWhite = parseCssColor('oklch(1 0 none)');
    expect(oklchWhite).toEqual([255, 255, 255]);

    const oklabBlack = parseCssColor('oklab(0 0 0)');
    expect(oklabBlack).toEqual([0, 0, 0]);

    // LightningCSS lowers oklch() to CIE lab() in production builds (including leading-dot decimals and unitless L).
    const labWhite = parseCssColor('lab(100% 0 0)');
    expect(labWhite).not.toBeNull();
    expect(contrastRatio(labWhite!, [0, 0, 0])).toBeGreaterThan(20);

    const lightningLabSurface = parseCssColor('lab(95.6384% -.0000298023 0)');
    const chromiumComputedLab = parseCssColor('lab(36.9888 0 -0.00000596046)');
    expect(lightningLabSurface).not.toBeNull();
    expect(chromiumComputedLab).not.toBeNull();
    expect(contrastRatio(chromiumComputedLab!, lightningLabSurface!)).toBeGreaterThanOrEqual(6.4);

    const lchAccent = parseCssColor('lch(55% 65 260)');
    expect(lchAccent).not.toBeNull();
    expect(parseCssColor('not-a-color')).toBeNull();
  });

  it('clamps foreground colors to satisfy target WCAG 2.2 contrast ratios', () => {
    const clampedLight = clampRgbContrast([200, 200, 200], [255, 255, 255], 4.5);
    expect(contrastRatio(clampedLight, [255, 255, 255])).toBeGreaterThanOrEqual(4.5);

    const clampedDark = clampRgbContrast([45, 45, 45], [10, 10, 12], 4.5);
    expect(contrastRatio(clampedDark, [10, 10, 12])).toBeGreaterThanOrEqual(4.5);
  });

  it('computes highlight SVG attributes with >= 3:1 boundary contrast and >= 4.5:1 text contrast', () => {
    for (const [bg, fg, accent] of [
      [
        [255, 255, 255],
        [17, 24, 39],
        [250, 204, 21],
      ],
      [
        [9, 9, 11],
        [244, 244, 245],
        [30, 58, 138],
      ],
    ] as const) {
      const styles = computeHighlightSvgStyles(bg, fg, accent);
      const fill = parseCssColor(styles.fill)!;
      const stroke = parseCssColor(styles.stroke)!;
      const opacity = Number.parseFloat(styles['fill-opacity']);
      const compositedPage = blendRgb(fill, bg, opacity);
      const compositedText = blendRgb(fill, fg, opacity);

      expect(styles['mix-blend-mode']).toBe('normal');
      expect(contrastRatio(stroke, bg)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(fill, bg)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(fg, compositedPage)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(compositedText, compositedPage)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('meets WCAG 2.2 AA link, focus, text, and highlight contrast across all 23 themes in light and dark modes', () => {
    expect(skeletonThemes).toHaveLength(23);

    for (const theme of skeletonThemes) {
      const vars = loadThemeVariables(theme);
      for (const mode of ['light', 'dark'] as const) {
        const palette = resolveReaderPalette(mode, (token) => vars.get(token) ?? '');
        const bg = parseCssColor(palette.background)!;
        const text = parseCssColor(palette.text)!;
        const link = parseCssColor(palette.link)!;
        const focusOuter = parseCssColor(palette.focusOuter)!;
        const focusInner = parseCssColor(palette.focusInner)!;
        const stroke = parseCssColor(palette.highlight.stroke)!;
        const fill = parseCssColor(palette.highlight.fill)!;
        const fillOpacity = Number.parseFloat(palette.highlight['fill-opacity']);
        const compositedPage = blendRgb(fill, bg, fillOpacity);
        const compositedText = blendRgb(fill, text, fillOpacity);

        expect(
          contrastRatio(text, bg),
          `${theme} (${mode}) body text contrast`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(link, bg),
          `${theme} (${mode}) inline link contrast`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(focusOuter, bg),
          `${theme} (${mode}) focus outer ring contrast`,
        ).toBeGreaterThanOrEqual(3);
        expect(
          contrastRatio(focusOuter, focusInner),
          `${theme} (${mode}) two-color focus ring separation`,
        ).toBeGreaterThanOrEqual(3);
        expect(
          contrastRatio(stroke, bg),
          `${theme} (${mode}) highlight stroke contrast`,
        ).toBeGreaterThanOrEqual(3);
        expect(
          contrastRatio(fill, bg),
          `${theme} (${mode}) highlight fill contrast`,
        ).toBeGreaterThanOrEqual(3);
        expect(
          contrastRatio(text, compositedPage),
          `${theme} (${mode}) raw text over highlight contrast`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(compositedText, compositedPage),
          `${theme} (${mode}) composited text over highlight contrast`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('scopes paired Skeleton tokens and two-color focus rings to [data-mode] blocks in app.css', () => {
    const appCss = readFileSync(resolve(process.cwd(), 'src/app.css'), 'utf8');
    expect(appCss).toContain("[data-mode='light']");
    expect(appCss).toContain("[data-mode='dark']");
    expect(appCss).toContain('--focus-ring-outer');
    expect(appCss).toContain('--focus-ring-inner');

    for (const role of [
      'primary',
      'secondary',
      'tertiary',
      'success',
      'warning',
      'error',
      'surface',
    ]) {
      expect(appCss).toContain(`--color-${role}-50-950: var(--color-${role}-50);`);
      expect(appCss).toContain(`--color-${role}-50-950: var(--color-${role}-950);`);
      expect(appCss).toContain(
        `--color-${role}-contrast-50-950: var(--color-${role}-contrast-50);`,
      );
      expect(appCss).toContain(
        `--color-${role}-contrast-50-950: var(--color-${role}-contrast-950);`,
      );
    }
  });
});
