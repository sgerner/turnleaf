// @vitest-environment node

import { build, type Rollup } from 'vite';
import { describe, expect, it } from 'vitest';

const READER_RAW_BYTE_BUDGET = 335_000;
const STARTUP_RAW_BYTE_BUDGET = 200_000;

describe('production bundle budgets and module exclusions', () => {
  it('trims Reader and startup index chunks within byte budgets and excludes dead or deferred modules', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousVitest = process.env.VITEST;
    process.env.NODE_ENV = 'production';
    delete process.env.VITEST;
    let result: Awaited<ReturnType<typeof build>>;
    try {
      result = await build({
        configFile: 'vite.config.ts',
        mode: 'production',
        logLevel: 'silent',
        build: {
          write: false,
        },
      });
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = previousVitest;
    }
    const output = (Array.isArray(result) ? result[0] : result) as Rollup.RollupOutput;
    const chunks = output.output.filter(
      (item): item is Rollup.OutputChunk => item.type === 'chunk',
    );

    const readerChunk = chunks.find((chunk) => /^assets\/Reader-.*\.js$/.test(chunk.fileName));
    const indexChunk = chunks.find((chunk) => /^assets\/index-.*\.js$/.test(chunk.fileName));

    expect(readerChunk).toBeDefined();
    expect(indexChunk).toBeDefined();

    const readerBytes = Buffer.byteLength(readerChunk!.code, 'utf8');
    const indexBytes = Buffer.byteLength(indexChunk!.code, 'utf8');

    expect(readerBytes).toBeLessThanOrEqual(READER_RAW_BYTE_BUDGET);
    expect(indexBytes).toBeLessThanOrEqual(STARTUP_RAW_BYTE_BUDGET);

    const readerModules = Object.keys(readerChunk!.modules).map((id) => id.replaceAll('\\', '/'));
    expect(readerModules.some((id) => id.includes('node_modules/@xmldom/xmldom'))).toBe(false);
    expect(readerModules.some((id) => id.includes('node_modules/localforage'))).toBe(false);
    expect(readerModules.some((id) => id.includes('node_modules/epubjs/src/store'))).toBe(false);
    expect(
      readerModules.some((id) => id.includes('node_modules/epubjs/src/managers/continuous/')),
    ).toBe(false);

    const indexModules = Object.keys(indexChunk!.modules).map((id) => id.replaceAll('\\', '/'));
    expect(indexModules.some((id) => id.endsWith('/src/lib/components/Onboarding.svelte'))).toBe(
      false,
    );
    expect(
      indexModules.some((id) => id.endsWith('/src/lib/components/LibrarySettingsModal.svelte')),
    ).toBe(false);
    expect(
      indexModules.some((id) => id.endsWith('/src/lib/components/DiagnosticsPanel.svelte')),
    ).toBe(false);
    expect(indexModules.some((id) => id.endsWith('/src/lib/components/Reader.svelte'))).toBe(false);
    expect(indexModules.some((id) => id.endsWith('/src/lib/downloads/epub-validation.ts'))).toBe(
      false,
    );
    expect(indexModules.some((id) => id.endsWith('/src/lib/downloads/native-download.ts'))).toBe(
      false,
    );
    expect(indexModules.some((id) => id.endsWith('/src/lib/github/releases.ts'))).toBe(false);
    expect(indexModules.some((id) => id.endsWith('/src/lib/database/schema.ts'))).toBe(false);
    expect(
      indexModules.some((id) => id.includes('@capacitor-community/sqlite/dist/esm/definitions')),
    ).toBe(false);
  }, 30_000);
});
