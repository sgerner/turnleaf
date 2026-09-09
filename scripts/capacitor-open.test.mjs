import { describe, expect, it } from 'vitest';
import { environmentWithOptionalDotEnv, openPlatform, parseDotEnv } from './capacitor-open.mjs';

describe('capacitor open helpers', () => {
  it('parses optional dotenv values without requiring a file', () => {
    expect(
      parseDotEnv(
        `\n# comment\nexport CAPACITOR_ANDROID_STUDIO_PATH="/opt/android studio"\nTURNLEAF_DEV_PROXY_ORIGINS=https://books.example.com:5000\n`,
      ),
    ).toEqual({
      CAPACITOR_ANDROID_STUDIO_PATH: '/opt/android studio',
      TURNLEAF_DEV_PROXY_ORIGINS: 'https://books.example.com:5000',
    });
  });

  it('lets the process environment override .env values', () => {
    expect(
      environmentWithOptionalDotEnv({
        env: { CAPACITOR_ANDROID_STUDIO_PATH: '/from-process' },
        envPath: '/path/that/does/not/exist',
      }).CAPACITOR_ANDROID_STUDIO_PATH,
    ).toBe('/from-process');
  });

  it('accepts only supported Capacitor platforms', () => {
    expect(openPlatform('android')).toBe('android');
    expect(() => openPlatform('web')).toThrow('android or ios');
  });
});
