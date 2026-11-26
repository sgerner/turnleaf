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

const MIN_FONT_SIZE = 14;
const MAX_FONT_SIZE = 34;

export function resolveDynamicTypeScale(
  root: Element | null = typeof document !== 'undefined' ? document.documentElement : null,
): number {
  if (!root) return 1;
  const inlineValue =
    'style' in root && root.style && typeof root.style === 'object'
      ? (root as HTMLElement).style.getPropertyValue('--turnleaf-text-scale').trim()
      : '';
  const computedValue =
    !inlineValue && typeof getComputedStyle === 'function'
      ? getComputedStyle(root).getPropertyValue('--turnleaf-text-scale').trim()
      : inlineValue;
  const parsed = Number(computedValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.min(2, Math.max(0.85, parsed));
}

export function defaultReaderFontSize(
  root: Element | null = typeof document !== 'undefined' ? document.documentElement : null,
): number {
  const scaled = Math.round(defaultAppearance.fontSize * resolveDynamicTypeScale(root));
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, scaled));
}

export function parseAppearance(value: string): Appearance {
  const parsed = JSON.parse(value) as Partial<Appearance>;
  const mode = parsed.mode === 'dark' ? 'dark' : 'light';
  return {
    ...defaultAppearance,
    ...parsed,
    mode,
    fontSize: Math.min(
      MAX_FONT_SIZE,
      Math.max(MIN_FONT_SIZE, Number(parsed.fontSize ?? defaultAppearance.fontSize)),
    ),
    lineHeight: Math.min(
      2,
      Math.max(1.2, Number(parsed.lineHeight ?? defaultAppearance.lineHeight)),
    ),
    bottomMargin: Math.min(
      64,
      Math.max(0, Number(parsed.bottomMargin ?? defaultAppearance.bottomMargin)),
    ),
    publisherStyles: parsed.publisherStyles !== false,
    progressBar: parsed.progressBar !== false,
    volumeButtons: parsed.volumeButtons === true,
  };
}
