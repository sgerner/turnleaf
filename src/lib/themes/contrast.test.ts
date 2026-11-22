import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { skeletonThemes, type SkeletonTheme } from './themes';

type ColorMode = 'light' | 'dark';

interface OklabColor {
  L: number;
  a: number;
  b: number;
  chroma: number;
  luminance: number;
}

const ROLES = [
  'primary',
  'secondary',
  'tertiary',
  'success',
  'warning',
  'error',
  'surface',
] as const;

const STEPS = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'] as const;

const repoUrl = (relativePath: string) => new URL(`../../../${relativePath}`, import.meta.url);

const appCss = readFileSync(repoUrl('src/app.css'), 'utf8');
const einkCss = readFileSync(repoUrl('src/lib/themes/eink.css'), 'utf8');
const appSvelte = readFileSync(repoUrl('src/App.svelte'), 'utf8');
const librarySvelte = readFileSync(repoUrl('src/lib/components/Library.svelte'), 'utf8');
const readerSvelte = readFileSync(repoUrl('src/lib/components/Reader.svelte'), 'utf8');
const skeletonBaseThemeCss = readFileSync(
  repoUrl('node_modules/@skeletonlabs/skeleton/src/base/theme.css'),
  'utf8',
);

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function oklabToColor(L: number, a: number, b: number): OklabColor {
  const lPrime = L + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = L - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = L - 0.0894841775 * a - 1.291485548 * b;

  const l = lPrime * lPrime * lPrime;
  const m = mPrime * mPrime * mPrime;
  const s = sPrime * sPrime * sPrime;

  const rLinearRaw = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gLinearRaw = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLinearRaw = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  const toGamma = (channel: number): number => {
    const clamped = clamp01(channel);
    return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  };

  const rSrgb = Math.round(toGamma(rLinearRaw) * 255) / 255;
  const gSrgb = Math.round(toGamma(gLinearRaw) * 255) / 255;
  const bSrgb = Math.round(toGamma(bLinearRaw) * 255) / 255;

  const toLinear = (channel: number): number =>
    channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);

  const luminance = 0.2126 * toLinear(rSrgb) + 0.7152 * toLinear(gSrgb) + 0.0722 * toLinear(bSrgb);
  return { L, a, b, chroma: Math.hypot(a, b), luminance };
}

function srgbToOklab(rSrgb: number, gSrgb: number, bSrgb: number): OklabColor {
  const toLinear = (channel: number): number =>
    channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);

  const r = toLinear(rSrgb);
  const g = toLinear(gSrgb);
  const b = toLinear(bSrgb);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const okA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const okB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  return {
    L,
    a: okA,
    b: okB,
    chroma: Math.hypot(okA, okB),
    luminance: 0.2126 * r + 0.7152 * g + 0.0722 * b,
  };
}

function contrastRatio(first: OklabColor, second: OklabColor): number {
  const lighter = Math.max(first.luminance, second.luminance);
  const darker = Math.min(first.luminance, second.luminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function splitTopLevelArgs(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < input.length; index += 1) {
    const ch = input[index];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(input.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(input.slice(start).trim());
  return parts;
}

function extractRuleDeclarations(css: string, selectorPredicate: (selector: string) => boolean) {
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const declarations = new Map<string, string>();
  const ruleRegex = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of cleaned.matchAll(ruleRegex)) {
    const rawSelectors = match[1]?.trim() ?? '';
    const body = match[2] ?? '';
    const selectors = rawSelectors.split(',').map((item) => item.trim());
    if (!selectors.some(selectorPredicate)) continue;
    for (const decl of body.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
      const prop = decl[1];
      const val = decl[2];
      if (prop && val) declarations.set(prop, val.trim());
    }
  }
  return declarations;
}

function extractPropertyFromSelector(css: string, selector: string, property: string): string {
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const ruleRegex = /([^{}]+)\{([^{}]*)\}/g;
  let found = '';
  for (const match of cleaned.matchAll(ruleRegex)) {
    const selectors = (match[1] ?? '').split(',').map((item) => item.trim());
    if (!selectors.includes(selector)) continue;
    const body = match[2] ?? '';
    const propRegex = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+);`);
    const propMatch = body.match(propRegex);
    if (propMatch?.[1]) found = propMatch[1].trim();
  }
  if (!found) {
    throw new Error(`Missing ${property} in selector ${selector}`);
  }
  return found;
}

function loadThemeMap(theme: SkeletonTheme): Map<string, string> {
  const vars = new Map<string, string>();
  const merge = (source: Map<string, string>) => {
    for (const [key, value] of source) vars.set(key, value);
  };

  merge(
    extractRuleDeclarations(
      skeletonBaseThemeCss,
      (sel) => sel === ':root' || sel === '@theme' || sel === '@theme inline',
    ),
  );

  const themeCss =
    theme === 'eink'
      ? einkCss
      : readFileSync(
          repoUrl(`node_modules/@skeletonlabs/skeleton/src/themes/${theme}.css`),
          'utf8',
        );
  merge(
    extractRuleDeclarations(themeCss, (sel) => sel.includes(`data-theme`) && sel.includes(theme)),
  );

  merge(extractRuleDeclarations(appCss, (sel) => sel === ':root' || sel === ':root[data-theme]'));
  merge(
    extractRuleDeclarations(
      appCss,
      (sel) => sel === `:root[data-theme='${theme}']` || sel === `[data-theme='${theme}']`,
    ),
  );

  return vars;
}

function evaluateColor(
  expression: string,
  vars: Map<string, string>,
  mode: ColorMode,
  depth = 0,
): OklabColor {
  if (depth > 20) {
    throw new Error(`Circular CSS variable reference in: ${expression}`);
  }
  const value = expression.trim();

  if (value === 'white') return oklabToColor(1, 0, 0);
  if (value === 'black') return oklabToColor(0, 0, 0);

  if (value.startsWith('#')) {
    const hex = value.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0]! + hex[0]!, 16) / 255;
      const g = parseInt(hex[1]! + hex[1]!, 16) / 255;
      const b = parseInt(hex[2]! + hex[2]!, 16) / 255;
      return srgbToOklab(r, g, b);
    }
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    return srgbToOklab(r, g, b);
  }

  if (value.startsWith('var(') && value.endsWith(')')) {
    const args = splitTopLevelArgs(value.slice(4, -1));
    const varName = args[0] ?? '';
    const resolved = vars.get(varName) ?? args[1];
    if (!resolved) {
      throw new Error(`Unresolved CSS variable ${varName}`);
    }
    if (resolved === 'inherit') {
      return evaluateColor(
        mode === 'light' ? 'var(--color-typo-base-light)' : 'var(--color-typo-base-dark)',
        vars,
        mode,
        depth + 1,
      );
    }
    return evaluateColor(resolved, vars, mode, depth + 1);
  }

  if (value.startsWith('light-dark(') && value.endsWith(')')) {
    const [lightExpr, darkExpr] = splitTopLevelArgs(value.slice(11, -1));
    return evaluateColor((mode === 'light' ? lightExpr : darkExpr) ?? '', vars, mode, depth + 1);
  }

  if (value.startsWith('color-mix(') && value.endsWith(')')) {
    const args = splitTopLevelArgs(value.slice(10, -1));
    const parseStop = (stop: string) => {
      const pctMatch = stop.match(/^(.*)\s+([\d.]+)%$/s);
      if (pctMatch?.[1] && pctMatch[2]) {
        return { expr: pctMatch[1].trim(), weight: parseFloat(pctMatch[2]) / 100 };
      }
      return { expr: stop.trim(), weight: null as number | null };
    };
    const first = parseStop(args[1] ?? '');
    const second = parseStop(args[2] ?? '');
    const w1 = first.weight ?? (second.weight !== null ? 1 - second.weight : 0.5);
    const w2 = second.weight ?? 1 - w1;
    const total = w1 + w2;
    const n1 = w1 / total;
    const n2 = w2 / total;
    const c1 = evaluateColor(first.expr, vars, mode, depth + 1);
    const c2 = evaluateColor(second.expr, vars, mode, depth + 1);
    return oklabToColor(c1.L * n1 + c2.L * n2, c1.a * n1 + c2.a * n2, c1.b * n1 + c2.b * n2);
  }

  if (value.startsWith('oklch(') && value.endsWith(')')) {
    const core = value.slice(6, -1).split('/')[0]?.trim() ?? '';
    const parts = core.split(/\s+/);
    const rawL = parts[0] ?? '0';
    const rawC = parts[1] ?? '0';
    const rawH = parts[2] ?? '0';
    const L = rawL.endsWith('%') ? parseFloat(rawL) / 100 : parseFloat(rawL);
    const C = rawC === 'none' ? 0 : parseFloat(rawC);
    let hueDeg = rawH === 'none' ? 0 : parseFloat(rawH);
    if (rawH.endsWith('rad')) hueDeg = (parseFloat(rawH) * 180) / Math.PI;
    const hueRad = (hueDeg * Math.PI) / 180;
    return oklabToColor(L, C * Math.cos(hueRad), C * Math.sin(hueRad));
  }

  throw new Error(`Unsupported color expression: ${value}`);
}

describe('theme contrast and control boundary normalization', () => {
  it('preserves all 23 skeletonThemes identifiers and default fennec theme', () => {
    expect(skeletonThemes).toHaveLength(23);
    expect(skeletonThemes).toContain('fennec');
    expect(skeletonThemes).toContain('eink');
    expect(appSvelte).toContain("const defaultTheme = 'fennec';");
  });

  it('keeps eink surface-50 pure white, surface-950 pure black, and zero chroma across all tokens', () => {
    const vars = loadThemeMap('eink');
    const surface50 = evaluateColor('var(--color-surface-50)', vars, 'light');
    const surface950 = evaluateColor('var(--color-surface-950)', vars, 'dark');

    expect(surface50.luminance).toBeCloseTo(1, 5);
    expect(surface950.luminance).toBeCloseTo(0, 5);

    for (const role of ROLES) {
      for (const step of STEPS) {
        const color = evaluateColor(`var(--color-${role}-${step})`, vars, 'light');
        expect(color.chroma, `eink --color-${role}-${step} chroma`).toBeCloseTo(0, 5);
      }
    }
  });

  it('enforces >= 4.5:1 text contrast across all 46 theme-mode combinations', () => {
    const textClassSelectors = [
      '.text-surface-600-400',
      '.text-surface-700-300',
      '.text-surface-800-200',
      '.text-surface-900-100',
      '.text-surface-950-50',
      '.text-error-700-300',
      '.text-primary-950-50',
      '.text-tertiary-700-300',
    ];
    const textExpressions = textClassSelectors.map((selector) => ({
      selector,
      expr: extractPropertyFromSelector(appCss, selector, 'color'),
    }));

    const tonalSelectors = [
      '.preset-tonal-surface',
      '.preset-tonal-primary',
      '.preset-tonal-secondary',
      '.preset-tonal-tertiary',
      '.preset-tonal-success',
      '.preset-tonal-warning',
      '.preset-tonal-error',
    ].map((selector) => ({
      selector,
      bgExpr: extractPropertyFromSelector(appCss, selector, 'background-color'),
      fgExpr: extractPropertyFromSelector(appCss, selector, 'color'),
    }));

    const failures: string[] = [];

    for (const theme of skeletonThemes) {
      const vars = loadThemeMap(theme);

      for (const mode of ['light', 'dark'] as const) {
        const rootBg = evaluateColor(
          mode === 'light' ? 'var(--color-root-bg-light)' : 'var(--color-root-bg-dark)',
          vars,
          mode,
        );
        const cardSurface = evaluateColor('var(--color-surface-50-950)', vars, mode);
        const baseText = evaluateColor(
          mode === 'light' ? 'var(--color-typo-base-light)' : 'var(--color-typo-base-dark)',
          vars,
          mode,
        );
        const placeholder = evaluateColor('var(--field-placeholder)', vars, mode);

        for (const [name, fg, bg] of [
          ['body base text on root', baseText, rootBg],
          ['body base text on card', baseText, cardSurface],
          ['::placeholder on input', placeholder, cardSurface],
        ] as const) {
          const ratio = contrastRatio(fg, bg);
          if (ratio < 4.5) {
            failures.push(`${theme}/${mode} ${name}: ${ratio.toFixed(2)}`);
          }
        }

        for (const { selector, expr } of textExpressions) {
          const fg = evaluateColor(expr, vars, mode);
          for (const [bgName, bg] of [
            ['root', rootBg],
            ['card', cardSurface],
          ] as const) {
            const ratio = contrastRatio(fg, bg);
            if (ratio < 4.5) {
              failures.push(`${theme}/${mode} ${selector} on ${bgName}: ${ratio.toFixed(2)}`);
            }
          }
        }

        for (const { selector, bgExpr, fgExpr } of tonalSelectors) {
          const bg = evaluateColor(bgExpr, vars, mode);
          const fg = evaluateColor(fgExpr, vars, mode);
          const ratio = contrastRatio(fg, bg);
          if (ratio < 4.5) {
            failures.push(`${theme}/${mode} ${selector}: ${ratio.toFixed(2)}`);
          }
        }

        for (const role of ROLES) {
          for (const step of STEPS) {
            const bg = evaluateColor(`var(--color-${role}-${step})`, vars, mode);
            const fg = evaluateColor(`var(--color-${role}-contrast-${step})`, vars, mode);
            const ratio = contrastRatio(fg, bg);
            if (ratio < 4.5) {
              failures.push(`${theme}/${mode} preset-filled-${role}-${step}: ${ratio.toFixed(2)}`);
            }
          }
        }

        const readerBarBg = evaluateColor(
          mode === 'light' ? 'var(--color-surface-50)' : 'var(--color-surface-950)',
          vars,
          mode,
        );
        const readerBarText = evaluateColor(
          mode === 'light'
            ? 'color-mix(in oklab, var(--color-surface-950) 50%, oklch(0 0 0))'
            : 'color-mix(in oklab, var(--color-surface-50) 50%, oklch(1 0 0))',
          vars,
          mode,
        );
        const readerTitleRatio = contrastRatio(readerBarText, readerBarBg);
        if (readerTitleRatio < 4.5) {
          failures.push(`${theme}/${mode} .reader-toolbar-title: ${readerTitleRatio.toFixed(2)}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('enforces >= 3:1 non-text contrast for borders, switches, progress bars, and focus outlines across all 46 theme-mode combinations', () => {
    const failures: string[] = [];

    for (const theme of skeletonThemes) {
      const vars = loadThemeMap(theme);

      for (const mode of ['light', 'dark'] as const) {
        const rootBg = evaluateColor(
          mode === 'light' ? 'var(--color-root-bg-light)' : 'var(--color-root-bg-dark)',
          vars,
          mode,
        );
        const cardSurface = evaluateColor('var(--color-surface-50-950)', vars, mode);
        const controlBorder = evaluateColor('var(--control-border)', vars, mode);
        const errorBorder = evaluateColor('var(--control-border-error)', vars, mode);
        const progressTrack = evaluateColor('var(--progress-track-bg)', vars, mode);
        const progressFill = evaluateColor('var(--progress-fill-bg)', vars, mode);
        const switchTrack = evaluateColor('var(--switch-track-bg)', vars, mode);
        const switchTrackChecked = evaluateColor('var(--switch-track-checked-bg)', vars, mode);
        const switchThumb = evaluateColor('var(--switch-thumb-bg)', vars, mode);
        const switchThumbChecked = evaluateColor('var(--switch-thumb-checked-bg)', vars, mode);
        const focusInner = evaluateColor('var(--focus-ring-inner)', vars, mode);
        const focusOuter = evaluateColor('var(--focus-ring-outer)', vars, mode);

        const checks: Array<[string, number]> = [
          ['control-border on root', contrastRatio(controlBorder, rootBg)],
          ['control-border on card', contrastRatio(controlBorder, cardSurface)],
          ['error-border on root', contrastRatio(errorBorder, rootBg)],
          ['error-border on card', contrastRatio(errorBorder, cardSurface)],
          ['progress-fill on progress-track', contrastRatio(progressFill, progressTrack)],
          ['progress-track border on card', contrastRatio(controlBorder, cardSurface)],
          ['unchecked switch-thumb on switch-track', contrastRatio(switchThumb, switchTrack)],
          [
            'checked switch-thumb on checked switch-track',
            contrastRatio(switchThumbChecked, switchTrackChecked),
          ],
          ['checked switch-track on card', contrastRatio(switchTrackChecked, cardSurface)],
          ['unchecked switch-track border on card', contrastRatio(controlBorder, cardSurface)],
          ['two-color focus inner vs outer', contrastRatio(focusInner, focusOuter)],
          [
            'two-color focus max contrast on root',
            Math.max(contrastRatio(focusInner, rootBg), contrastRatio(focusOuter, rootBg)),
          ],
          [
            'two-color focus max contrast on card',
            Math.max(
              contrastRatio(focusInner, cardSurface),
              contrastRatio(focusOuter, cardSurface),
            ),
          ],
        ];

        for (const [label, ratio] of checks) {
          if (ratio < 3) {
            failures.push(`${theme}/${mode} ${label}: ${ratio.toFixed(2)}`);
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('configures non-color pressed state cues, two-color focus outlines, and opaque reader toolbar styling', () => {
    expect(appCss).toContain("button[aria-pressed='true']");
    expect(appCss).toContain('inset 0 0 0 2px currentColor');
    expect(appCss).toContain('--focus-ring-inner');
    expect(appCss).toContain('--focus-ring-outer');
    expect(librarySvelte).toContain('progress-track');
    expect(librarySvelte).toContain('progress-fill');
    expect(readerSvelte).toContain('color: var(--reader-bar-text);');
    expect(readerSvelte).toContain('background: var(--reader-bar-bg);');
  });
});
