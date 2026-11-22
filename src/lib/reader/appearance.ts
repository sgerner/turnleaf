export type ReadingMode = 'light' | 'dark';

export interface Appearance {
  mode: ReadingMode;
  fontFamily: 'book' | 'sans' | 'accessible';
  fontSize: number;
  lineHeight: number;
  paragraphSpacing: number;
  margin: number;
  bottomMargin: number;
  alignment: 'start' | 'justify';
  publisherStyles: boolean;
  hyphenation: boolean;
  progressBar: boolean;
  keepAwake: boolean;
  volumeButtons: boolean;
}

export const defaultAppearance: Appearance = {
  mode: 'light',
  fontFamily: 'book',
  fontSize: 18,
  lineHeight: 1.55,
  paragraphSpacing: 0.6,
  margin: 24,
  bottomMargin: 0,
  alignment: 'start',
  publisherStyles: true,
  hyphenation: false,
  progressBar: true,
  keepAwake: false,
  volumeButtons: false,
};

export function serializeAppearance(value: Appearance): string {
  return JSON.stringify(value);
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return fallback;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

export function parseAppearance(value: string): Appearance {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return { ...defaultAppearance };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...defaultAppearance };
  }
  const parsed = raw as Partial<Record<keyof Appearance, unknown>>;
  const mode: ReadingMode = parsed.mode === 'dark' ? 'dark' : 'light';
  const fontFamily: Appearance['fontFamily'] =
    parsed.fontFamily === 'book' ||
    parsed.fontFamily === 'sans' ||
    parsed.fontFamily === 'accessible'
      ? parsed.fontFamily
      : defaultAppearance.fontFamily;
  const alignment: Appearance['alignment'] =
    parsed.alignment === 'start' || parsed.alignment === 'justify'
      ? parsed.alignment
      : defaultAppearance.alignment;
  return {
    mode,
    fontFamily,
    fontSize: boundedNumber(parsed.fontSize, defaultAppearance.fontSize, 14, 34),
    lineHeight: boundedNumber(parsed.lineHeight, defaultAppearance.lineHeight, 1.2, 2),
    paragraphSpacing: boundedNumber(
      parsed.paragraphSpacing,
      defaultAppearance.paragraphSpacing,
      0,
      1.5,
    ),
    margin: boundedNumber(parsed.margin, defaultAppearance.margin, 8, 56),
    bottomMargin: boundedNumber(parsed.bottomMargin, defaultAppearance.bottomMargin, 0, 64),
    alignment,
    publisherStyles:
      typeof parsed.publisherStyles === 'boolean'
        ? parsed.publisherStyles
        : defaultAppearance.publisherStyles,
    hyphenation: parsed.hyphenation === true,
    progressBar: parsed.progressBar !== false,
    keepAwake: parsed.keepAwake === true,
    volumeButtons: parsed.volumeButtons === true,
  };
}
