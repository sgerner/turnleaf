import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');

function collectFiles(directory: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

describe('native vector splash assets and launch configuration', () => {
  it('removes all Android splash.png bitmaps and configures AndroidX SplashScreen vector launch', () => {
    const androidResFiles = collectFiles(join(repoRoot, 'android/app/src/main/res'));
    const splashPngs = androidResFiles.filter((file) => file.endsWith('/splash.png'));
    expect(splashPngs).toEqual([]);

    const stylesXml = readFileSync(
      join(repoRoot, 'android/app/src/main/res/values/styles.xml'),
      'utf8',
    );
    expect(stylesXml).toContain('name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen"');
    expect(stylesXml).toContain(
      '<item name="windowSplashScreenBackground">@color/splash_background</item>',
    );
    expect(stylesXml).toContain(
      '<item name="windowSplashScreenAnimatedIcon">@drawable/ic_splash_mark</item>',
    );
    expect(stylesXml).toContain(
      '<item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>',
    );
    expect(stylesXml).not.toContain('@drawable/splash');

    const lightColorsXml = readFileSync(
      join(repoRoot, 'android/app/src/main/res/values/colors.xml'),
      'utf8',
    );
    const nightColorsXml = readFileSync(
      join(repoRoot, 'android/app/src/main/res/values-night/colors.xml'),
      'utf8',
    );
    expect(lightColorsXml).toContain('<color name="splash_background">');
    expect(nightColorsXml).toContain('<color name="splash_background">#212227</color>');

    const vectorDrawable = readFileSync(
      join(repoRoot, 'android/app/src/main/res/drawable/ic_splash_mark.xml'),
      'utf8',
    );
    expect(vectorDrawable).toContain('<vector');
    expect(vectorDrawable).toContain('<path');

    const mainActivity = readFileSync(
      join(repoRoot, 'android/app/src/main/java/app/turnleaf/reader/MainActivity.java'),
      'utf8',
    );
    const installIndex = mainActivity.indexOf('SplashScreen.installSplashScreen(this);');
    const superIndex = mainActivity.indexOf('super.onCreate(savedInstanceState);');
    expect(installIndex).toBeGreaterThan(-1);
    expect(superIndex).toBeGreaterThan(installIndex);
  });

  it('replaces iOS 2732x2732 splash bitmaps with a centered vector mark over dark-aware colors', () => {
    const splashImagesetDir = join(repoRoot, 'ios/App/App/Assets.xcassets/Splash.imageset');
    const splashFiles = collectFiles(splashImagesetDir);
    expect(splashFiles.filter((file) => /2732x2732|\.png$/i.test(file))).toEqual([]);

    const splashContents = JSON.parse(
      readFileSync(join(splashImagesetDir, 'Contents.json'), 'utf8'),
    ) as {
      images: Array<{ filename?: string; idiom?: string }>;
      properties?: { 'preserves-vector-representation'?: boolean };
    };
    expect(splashContents.images).toEqual([{ filename: 'splash-mark.svg', idiom: 'universal' }]);
    expect(splashContents.properties?.['preserves-vector-representation']).toBe(true);

    const svgMark = readFileSync(join(splashImagesetDir, 'splash-mark.svg'), 'utf8');
    expect(svgMark).toContain('<svg');
    expect(svgMark).toContain('<path');

    const colorContents = JSON.parse(
      readFileSync(
        join(repoRoot, 'ios/App/App/Assets.xcassets/SplashBackground.colorset/Contents.json'),
        'utf8',
      ),
    ) as {
      colors: Array<{ appearances?: Array<{ appearance: string; value: string }> }>;
    };
    expect(colorContents.colors).toHaveLength(2);
    expect(
      colorContents.colors.some((entry) =>
        entry.appearances?.some(
          (appearance) => appearance.appearance === 'luminosity' && appearance.value === 'dark',
        ),
      ),
    ).toBe(true);

    const storyboard = readFileSync(
      join(repoRoot, 'ios/App/App/Base.lproj/LaunchScreen.storyboard'),
      'utf8',
    );
    expect(storyboard).toContain('name="SplashBackground"');
    expect(storyboard).toContain('contentMode="scaleAspectFit"');
    expect(storyboard).toContain('firstAttribute="centerX"');
    expect(storyboard).toContain('firstAttribute="centerY"');
    expect(storyboard).not.toContain('contentMode="scaleAspectFill"');
    expect(storyboard).not.toContain('width="1366"');
  });
});
