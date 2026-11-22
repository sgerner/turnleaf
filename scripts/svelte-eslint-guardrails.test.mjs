import { ESLint } from 'eslint';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const eslint = new ESLint({ cwd: repoRoot });

async function lintSnippet(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath });
  return result;
}

describe('Svelte and ESLint zero-warning guardrails', () => {
  it('enforces zero warnings in check and lint scripts wired into build and verify', () => {
    expect(packageJson.scripts.check).toContain('svelte-check');
    expect(packageJson.scripts.check).toContain('--tsconfig ./tsconfig.app.json');
    expect(packageJson.scripts.check).toContain('--fail-on-warnings');
    expect(packageJson.scripts.check).toContain('tsc -p tsconfig.node.json');

    expect(packageJson.scripts.lint).toContain('eslint');
    expect(packageJson.scripts.lint).toContain('--max-warnings=0');

    expect(packageJson.scripts.build).toContain('npm run check');
    expect(packageJson.scripts.verify).toContain('npm run lint');
    expect(packageJson.scripts.verify).toContain('npm run check');
  });

  it('configures TypeScript ESLint parsing for .svelte, .svelte.ts, and .svelte.js files without projectService', async () => {
    for (const target of [
      'src/lib/Component.svelte',
      'src/lib/runes.svelte.ts',
      'src/lib/runes.svelte.js',
    ]) {
      const config = await eslint.calculateConfigForFile(target);
      expect(config.languageOptions?.parserOptions?.parser).toBe(tseslint.parser);
      expect(config.languageOptions?.parserOptions?.extraFileExtensions).toEqual(['.svelte']);
      expect(config.languageOptions?.parserOptions?.projectService).toBeUndefined();
    }
  });

  it('parses Svelte 5 runes and TypeScript syntax in .svelte.ts and .svelte.js modules', async () => {
    const tsModuleResult = await lintSnippet(
      [
        'export interface CounterState {',
        '  readonly count: number;',
        '  increment: () => void;',
        '}',
        '',
        'export function createCounter(initial: number): CounterState {',
        '  let count = $state<number>(initial);',
        '  const current = $derived(count);',
        '  return {',
        '    get count() {',
        '      return current;',
        '    },',
        '    increment() {',
        '      count += 1;',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
      'src/lib/counter.svelte.ts',
    );
    expect(tsModuleResult.messages).toEqual([]);

    const typeImportRuleResult = await lintSnippet(
      [
        "import { CounterState } from './counter.svelte.ts';",
        'export type CounterSnapshot = CounterState;',
        '',
      ].join('\n'),
      'src/lib/counter-consumer.svelte.ts',
    );
    expect(typeImportRuleResult.messages.map((message) => message.ruleId)).toContain(
      '@typescript-eslint/consistent-type-imports',
    );

    const jsModuleResult = await lintSnippet(
      [
        'export function createToggle(initial = false) {',
        '  let open = $state(Boolean(initial));',
        '  const label = $derived(open ? "open" : "closed");',
        '  return {',
        '    get label() {',
        '      return label;',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
      'src/lib/toggle.svelte.js',
    );
    expect(jsModuleResult.messages).toEqual([]);
  });

  it('allows TypeScript DOM types in src .svelte components and flags Svelte debug warnings', async () => {
    const domTypeResult = await lintSnippet(
      [
        '<script lang="ts">',
        '  let listener: EventListenerOrEventListenerObject | null = null;',
        '  let options: AddEventListenerOptions = { passive: true };',
        '  let block = $state<ScrollLogicalPosition>("nearest");',
        '</script>',
        '',
        '<p>{block}{listener ? "bound" : options.passive ? "passive" : "idle"}</p>',
        '',
      ].join('\n'),
      'src/lib/components/DomTypesFixture.svelte',
    );
    expect(domTypeResult.messages).toEqual([]);

    const debugWarningResult = await lintSnippet(
      [
        '<script lang="ts">',
        '  let page = $state(1);',
        '  $inspect(page);',
        '</script>',
        '',
        '{@debug page}',
        '<p>{page}</p>',
        '',
      ].join('\n'),
      'src/lib/components/DebugWarningFixture.svelte',
    );
    expect(debugWarningResult.warningCount).toBe(2);
    expect(debugWarningResult.messages.map((message) => message.ruleId)).toEqual(
      expect.arrayContaining(['svelte/no-inspect', 'svelte/no-at-debug-tags']),
    );
  });

  it('disables no-undef only for typed src Svelte files while preserving it for untyped and non-src files', async () => {
    for (const typedSrcFile of ['src/App.svelte', 'src/lib/state.svelte.ts']) {
      const config = await eslint.calculateConfigForFile(typedSrcFile);
      const severity = Array.isArray(config.rules?.['no-undef'])
        ? config.rules['no-undef'][0]
        : config.rules?.['no-undef'];
      expect(severity).toBe(0);
    }

    const untypedTargets = [
      {
        filePath: 'scripts/untyped-fixture.mjs',
        code: 'export const value = missingRuntimeGlobal;\n',
      },
      {
        filePath: 'scripts/untyped-fixture.js',
        code: 'export const value = missingRuntimeGlobal;\n',
      },
      {
        filePath: 'src/lib/untyped-fixture.svelte.js',
        code: 'export const value = missingRuntimeGlobal;\n',
      },
      {
        filePath: 'scripts/OutsideSrcFixture.svelte',
        code: '<script>\n  const value = missingRuntimeGlobal;\n</script>\n\n<p>{value}</p>\n',
      },
    ];

    for (const target of untypedTargets) {
      const result = await lintSnippet(target.code, target.filePath);
      expect(
        result.messages.some((message) => message.ruleId === 'no-undef'),
        `Expected no-undef in ${target.filePath}`,
      ).toBe(true);
    }
  });
});
