import { describe, expect, it } from 'vitest';
import { defaultAppearance, parseAppearance, serializeAppearance } from './appearance';

describe('appearance serialization', () => {
  it('round trips supported preferences', () => {
    const dark = { ...defaultAppearance, mode: 'dark' as const, fontSize: 22 };
    expect(parseAppearance(serializeAppearance(dark))).toEqual(dark);
  });

  it('bounds unsafe numeric values', () => {
    expect(parseAppearance('{"fontSize":200,"lineHeight":0}')).toMatchObject({
      fontSize: 34,
      lineHeight: 1.2,
    });
  });

  it('defaults the progress bar on', () => {
    expect(parseAppearance('{}').progressBar).toBe(true);
    expect(parseAppearance('{"progressBar":false}').progressBar).toBe(false);
  });
});
