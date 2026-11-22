import type { ReadingMode } from './appearance';

export type RgbColor = readonly [number, number, number];

export interface HighlightSvgStyles {
  fill: string;
  'fill-opacity': string;
  stroke: string;
  'stroke-opacity': string;
  'stroke-width': string;
  'mix-blend-mode': string;
}

export interface ResolvedReaderPalette {
  background: string;
  text: string;
  link: string;
  selection: string;
  focusOuter: string;
  focusInner: string;
  highlight: HighlightSvgStyles;
}

const FALLBACK_COLORS: Record<
  ReadingMode,
  {
    background: RgbColor;
    text: RgbColor;
    link: RgbColor;
    accent: RgbColor;
    selection: RgbColor;
  }
> = {
  light: {
    background: [255, 255, 255],
    text: [17, 24, 39],
    link: [29, 78, 216],
    accent: [180, 83, 9],
    selection: [191, 219, 254],
  },
  dark: {
    background: [9, 9, 11],
    text: [244, 244, 245],
    link: [147, 197, 253],
    accent: [251, 191, 36],
    selection: [30, 58, 138],
  },
};

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function linearToSrgbByte(linear: number): number {
  const c = clampUnit(linear);
  const encoded = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return clampByte(encoded * 255);
}

function srgbByteToLinear(byte: number): number {
  const c = clampUnit(byte / 255);
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function oklabToRgb(L: number, a: number, b: number): RgbColor {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [linearToSrgbByte(r), linearToSrgbByte(g), linearToSrgbByte(bl)];
}

function cieLabToRgb(L: number, a: number, b: number): RgbColor {
  const kappa = 24389 / 27;
  const epsilon = 216 / 24389;
  const f1 = (L + 16) / 116;
  const f0 = a / 500 + f1;
  const f2 = f1 - b / 200;
  const x = f0 * f0 * f0 > epsilon ? f0 * f0 * f0 : (116 * f0 - 16) / kappa;
  const y = L > kappa * epsilon ? Math.pow((L + 16) / 116, 3) : L / kappa;
  const z = f2 * f2 * f2 > epsilon ? f2 * f2 * f2 : (116 * f2 - 16) / kappa;
  const x50 = x * (0.3457 / 0.3585);
  const y50 = y;
  const z50 = z * ((1 - 0.3457 - 0.3585) / 0.3585);
  const x65 = 0.9554734527042182 * x50 - 0.023098536874261423 * y50 + 0.0632593086610217 * z50;
  const y65 = -0.028369706963208136 * x50 + 1.0099954580058226 * y50 + 0.021041398966943008 * z50;
  const z65 = 0.012314001688319899 * x50 - 0.020507696433477912 * y50 + 1.3303659366080753 * z50;
  const r = 3.2409699419045226 * x65 - 1.537383177570094 * y65 - 0.4986107602930034 * z65;
  const g = -0.9692436362808796 * x65 + 1.8759675015077202 * y65 + 0.04155505740717559 * z65;
  const bl = 0.05563007969699366 * x65 - 0.20397695888897652 * y65 + 1.0569715142428786 * z65;
  return [linearToSrgbByte(r), linearToSrgbByte(g), linearToSrgbByte(bl)];
}

function parseAngleDegrees(raw: string): number {
  const token = raw.trim().toLowerCase();
  if (token === 'none') return 0;
  const value = Number.parseFloat(token);
  if (!Number.isFinite(value)) return 0;
  if (token.endsWith('rad')) return (value * 180) / Math.PI;
  if (token.endsWith('grad')) return value * 0.9;
  if (token.endsWith('turn')) return value * 360;
  return value;
}

function parseChannel(token: string, percentScale: number): number | null {
  const trimmed = token.trim().toLowerCase();
  if (trimmed === 'none') return 0;
  const numeric = Number.parseFloat(trimmed);
  if (!Number.isFinite(numeric)) return null;
  return trimmed.endsWith('%') ? (numeric / 100) * percentScale : numeric;
}

function splitFunctionArgs(body: string): string[] {
  const withoutAlpha = body.split('/')[0] ?? body;
  return withoutAlpha
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
}

export function parseCssColor(value: string): RgbColor | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = Number.parseInt(hex[0]! + hex[0]!, 16);
      const g = Number.parseInt(hex[1]! + hex[1]!, 16);
      const b = Number.parseInt(hex[2]! + hex[2]!, 16);
      return [r, g, b].every(Number.isFinite) ? [r, g, b] : null;
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      return [r, g, b].every(Number.isFinite) ? [r, g, b] : null;
    }
    return null;
  }

  const fnMatch = trimmed.match(/^([a-z]+)\((.+)\)$/i);
  if (!fnMatch?.[1] || !fnMatch[2]) return null;
  const fn = fnMatch[1].toLowerCase();
  const args = splitFunctionArgs(fnMatch[2]);

  if ((fn === 'rgb' || fn === 'rgba') && args.length >= 3) {
    const r = parseChannel(args[0]!, 255);
    const g = parseChannel(args[1]!, 255);
    const b = parseChannel(args[2]!, 255);
    if (r === null || g === null || b === null) return null;
    return [clampByte(r), clampByte(g), clampByte(b)];
  }

  if ((fn === 'hsl' || fn === 'hsla') && args.length >= 3) {
    const h = (((parseAngleDegrees(args[0]!) % 360) + 360) % 360) / 60;
    const s = parseChannel(args[1]!, 1);
    const l = parseChannel(args[2]!, 1);
    if (s === null || l === null) return null;
    const sat = clampUnit(args[1]!.endsWith('%') ? s : s / 100);
    const light = clampUnit(args[2]!.endsWith('%') ? l : l / 100);
    const chroma = (1 - Math.abs(2 * light - 1)) * sat;
    const x = chroma * (1 - Math.abs((h % 2) - 1));
    const m = light - chroma / 2;
    const [r1, g1, b1] =
      h < 1
        ? [chroma, x, 0]
        : h < 2
          ? [x, chroma, 0]
          : h < 3
            ? [0, chroma, x]
            : h < 4
              ? [0, x, chroma]
              : h < 5
                ? [x, 0, chroma]
                : [chroma, 0, x];
    return [clampByte((r1 + m) * 255), clampByte((g1 + m) * 255), clampByte((b1 + m) * 255)];
  }

  if (fn === 'oklch' && args.length >= 3) {
    const L = parseChannel(args[0]!, 1);
    const C = parseChannel(args[1]!, 0.4);
    if (L === null || C === null) return null;
    const hRad = (parseAngleDegrees(args[2]!) * Math.PI) / 180;
    return oklabToRgb(L, C * Math.cos(hRad), C * Math.sin(hRad));
  }

  if (fn === 'oklab' && args.length >= 3) {
    const L = parseChannel(args[0]!, 1);
    const a = parseChannel(args[1]!, 0.4);
    const b = parseChannel(args[2]!, 0.4);
    if (L === null || a === null || b === null) return null;
    return oklabToRgb(L, a, b);
  }

  if (fn === 'lab' && args.length >= 3) {
    const L = parseChannel(args[0]!, 100);
    const a = parseChannel(args[1]!, 125);
    const b = parseChannel(args[2]!, 125);
    if (L === null || a === null || b === null) return null;
    return cieLabToRgb(L, a, b);
  }

  if (fn === 'lch' && args.length >= 3) {
    const L = parseChannel(args[0]!, 100);
    const C = parseChannel(args[1]!, 150);
    if (L === null || C === null) return null;
    const hRad = (parseAngleDegrees(args[2]!) * Math.PI) / 180;
    return cieLabToRgb(L, C * Math.cos(hRad), C * Math.sin(hRad));
  }

  return null;
}

export function formatHexColor([r, g, b]: RgbColor): string {
  return `#${[r, g, b].map((channel) => clampByte(channel).toString(16).padStart(2, '0')).join('')}`;
}

export function relativeLuminance([r, g, b]: RgbColor): number {
  return 0.2126 * srgbByteToLinear(r) + 0.7152 * srgbByteToLinear(g) + 0.0722 * srgbByteToLinear(b);
}

export function contrastRatio(first: RgbColor, second: RgbColor): number {
  const l1 = relativeLuminance(first);
  const l2 = relativeLuminance(second);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export function blendRgb(foreground: RgbColor, background: RgbColor, alpha: number): RgbColor {
  const weight = clampUnit(alpha);
  return [
    clampByte(weight * foreground[0] + (1 - weight) * background[0]),
    clampByte(weight * foreground[1] + (1 - weight) * background[1]),
    clampByte(weight * foreground[2] + (1 - weight) * background[2]),
  ];
}

export function clampRgbContrast(
  foreground: RgbColor,
  background: RgbColor,
  minRatio: number,
): RgbColor {
  if (contrastRatio(foreground, background) >= minRatio) return foreground;
  const target: RgbColor = relativeLuminance(background) > 0.179 ? [0, 0, 0] : [255, 255, 255];
  let low = 0;
  let high = 1;
  let best: RgbColor = target;
  for (let step = 0; step < 24; step += 1) {
    const mid = (low + high) / 2;
    const candidate = blendRgb(target, foreground, mid);
    if (contrastRatio(candidate, background) >= minRatio) {
      best = candidate;
      high = mid;
    } else {
      low = mid;
    }
  }
  return best;
}

function readTokenColor(
  getPropertyValue: (token: string) => string,
  token: string,
  fallback: RgbColor,
): RgbColor {
  let raw = getPropertyValue(token).trim();
  for (let depth = 0; depth < 5 && raw.startsWith('var('); depth += 1) {
    const inner = raw.slice(4, -1).split(',')[0]?.trim() ?? '';
    if (!inner) break;
    raw = getPropertyValue(inner).trim();
  }
  return parseCssColor(raw) ?? fallback;
}

export function computeHighlightSvgStyles(
  background: RgbColor,
  text: RgbColor,
  accent: RgbColor,
): HighlightSvgStyles {
  const stroke = clampRgbContrast(accent, background, 4.6);
  const fill = clampRgbContrast(accent, background, 3.5);
  let chosenOpacity = 0.12;
  for (
    let candidate = 0.2;
    candidate >= 0.1;
    candidate = Math.round((candidate - 0.02) * 100) / 100
  ) {
    const compositedPage = blendRgb(fill, background, candidate);
    const compositedText = blendRgb(fill, text, candidate);
    if (
      contrastRatio(compositedText, compositedPage) >= 4.6 &&
      contrastRatio(text, compositedPage) >= 4.6 &&
      contrastRatio(stroke, compositedPage) >= 3.2
    ) {
      chosenOpacity = candidate;
      break;
    }
  }
  return {
    fill: formatHexColor(fill),
    'fill-opacity': chosenOpacity.toFixed(2),
    stroke: formatHexColor(stroke),
    'stroke-opacity': '1',
    'stroke-width': '1.5',
    'mix-blend-mode': 'normal',
  };
}

export function resolveReaderPalette(
  mode: ReadingMode,
  getPropertyValue: (token: string) => string,
): ResolvedReaderPalette {
  const defaults = FALLBACK_COLORS[mode];
  const background = readTokenColor(
    getPropertyValue,
    mode === 'light' ? '--color-surface-50' : '--color-surface-950',
    defaults.background,
  );
  const rawText = readTokenColor(
    getPropertyValue,
    mode === 'light' ? '--color-surface-950' : '--color-surface-50',
    defaults.text,
  );
  const text = clampRgbContrast(rawText, background, 4.6);
  const rawLink = readTokenColor(
    getPropertyValue,
    mode === 'light' ? '--color-primary-700' : '--color-primary-300',
    defaults.link,
  );
  const link = clampRgbContrast(rawLink, background, 4.6);
  const rawAccent = readTokenColor(
    getPropertyValue,
    mode === 'light' ? '--color-primary-600' : '--color-primary-400',
    rawLink,
  );
  const selection = readTokenColor(
    getPropertyValue,
    mode === 'light' ? '--color-primary-200' : '--color-primary-800',
    defaults.selection,
  );
  const focusOuter = clampRgbContrast(text, background, 7);
  return {
    background: formatHexColor(background),
    text: formatHexColor(text),
    link: formatHexColor(link),
    selection: formatHexColor(selection),
    focusOuter: formatHexColor(focusOuter),
    focusInner: formatHexColor(background),
    highlight: computeHighlightSvgStyles(background, text, rawAccent),
  };
}
