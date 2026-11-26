import { describe, expect, it } from 'vitest';
import {
  defaultAppearance,
  defaultReaderFontSize,
  parseAppearance,
  resolveDynamicTypeScale,
  serializeAppearance,
} from './appearance';

describe('appearance serialization', () => {
  it('round trips supported preferences', () => {
    const dark = { ...defaultAppearance, mode: 'dark' as const, fontSize: 22 };
    expect(parseAppearance(serializeAppearance(dark))).toEqual(dark);
  });

  it('bounds unsafe numeric values', () => {
    expect(parseAppearance('{"fontSize":200,"lineHeight":0,"bottomMargin":200}')).toMatchObject({
      fontSize: 34,
      lineHeight: 1.2,
      bottomMargin: 64,
    });
  });

  it('defaults the bottom margin for older saved appearances', () => {
    expect(parseAppearance('{}').bottomMargin).toBe(defaultAppearance.bottomMargin);
    expect(parseAppearance('{"bottomMargin":-4}').bottomMargin).toBe(0);
  });

  it('defaults the progress bar on', () => {
    expect(parseAppearance('{}').progressBar).toBe(true);
    expect(parseAppearance('{"progressBar":false}').progressBar).toBe(false);
  });

  it('defaults keeping the screen awake off', () => {
    expect(parseAppearance('{}').keepAwake).toBe(false);
    expect(parseAppearance('{"keepAwake":true}').keepAwake).toBe(true);
  });

  it('defaults publisher styles on while preserving an explicit opt-out', () => {
    expect(defaultAppearance.publisherStyles).toBe(true);
    expect(parseAppearance('{}').publisherStyles).toBe(true);
    expect(parseAppearance('{"publisherStyles":true}').publisherStyles).toBe(true);
    expect(parseAppearance('{"publisherStyles":false}').publisherStyles).toBe(false);
  });

  it('defaults volume buttons off while preserving an explicit opt-in', () => {
    expect(defaultAppearance.volumeButtons).toBe(false);
    expect(parseAppearance('{}').volumeButtons).toBe(false);
    expect(parseAppearance('{"volumeButtons":true}').volumeButtons).toBe(true);
    expect(parseAppearance('{"volumeButtons":false}').volumeButtons).toBe(false);
  });

  it('resolves and clamps --turnleaf-text-scale for uncustomized default reader font size', () => {
    expect(resolveDynamicTypeScale(null)).toBe(1);
    expect(defaultReaderFontSize(null)).toBe(18);

    const root = {
      style: {
        value: '',
        getPropertyValue(name: string) {
          return name === '--turnleaf-text-scale' ? this.value : '';
        },
      },
    } as unknown as Element;

    expect(resolveDynamicTypeScale(root)).toBe(1);
    expect(defaultReaderFontSize(root)).toBe(18);

    (root as unknown as { style: { value: string } }).style.value = '1.5';
    expect(resolveDynamicTypeScale(root)).toBe(1.5);
    expect(defaultReaderFontSize(root)).toBe(27);

    (root as unknown as { style: { value: string } }).style.value = '2.5';
    expect(resolveDynamicTypeScale(root)).toBe(2);
    expect(defaultReaderFontSize(root)).toBe(34);

    (root as unknown as { style: { value: string } }).style.value = '0.5';
    expect(resolveDynamicTypeScale(root)).toBe(0.85);
    expect(defaultReaderFontSize(root)).toBe(15);

    (root as unknown as { style: { value: string } }).style.value = 'not-a-number';
    expect(resolveDynamicTypeScale(root)).toBe(1);
  });
});
