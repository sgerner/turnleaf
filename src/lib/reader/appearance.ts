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

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' && typeof value !== 'string') return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

export function serializeAppearance(value: Appearance): string {
  return JSON.stringify(value);
}

export function parseAppearance(value: string): Appearance {
  const parsed = JSON.parse(value) as Partial<Appearance>;
  const mode = parsed.mode === 'dark' ? 'dark' : 'light';
  return {
    ...defaultAppearance,
    ...parsed,
    mode,
    fontSize: clampNumber(parsed.fontSize, 14, 34, defaultAppearance.fontSize),
    lineHeight: clampNumber(parsed.lineHeight, 1.2, 2, defaultAppearance.lineHeight),
    paragraphSpacing: clampNumber(
      parsed.paragraphSpacing,
      0,
      1.5,
      defaultAppearance.paragraphSpacing,
    ),
    margin: clampNumber(parsed.margin, 8, 56, defaultAppearance.margin),
    bottomMargin: clampNumber(parsed.bottomMargin, 0, 64, defaultAppearance.bottomMargin),
    progressBar: parsed.progressBar !== false,
    volumeButtons: parsed.volumeButtons === true,
  };
}
