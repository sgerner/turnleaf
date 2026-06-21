export type ReadingMode = 'light' | 'dark';

export interface Appearance {
  mode: ReadingMode;
  fontFamily: 'book' | 'sans' | 'accessible';
  fontSize: number;
  lineHeight: number;
  paragraphSpacing: number;
  margin: number;
  alignment: 'start' | 'justify';
  publisherStyles: boolean;
  hyphenation: boolean;
  progressBar: boolean;
}

export const defaultAppearance: Appearance = {
  mode: 'light',
  fontFamily: 'book',
  fontSize: 18,
  lineHeight: 1.55,
  paragraphSpacing: 0.6,
  margin: 24,
  alignment: 'start',
  publisherStyles: true,
  hyphenation: false,
  progressBar: true,
};

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
    fontSize: Math.min(34, Math.max(14, Number(parsed.fontSize ?? defaultAppearance.fontSize))),
    lineHeight: Math.min(
      2,
      Math.max(1.2, Number(parsed.lineHeight ?? defaultAppearance.lineHeight)),
    ),
    progressBar: parsed.progressBar !== false,
  };
}
