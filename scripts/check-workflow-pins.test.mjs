import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  auditWorkflowContent,
  checkWorkflowPins,
  formatPinViolations,
  validateUsesReference,
} from './check-workflow-pins.mjs';

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), 'check-workflow-pins.mjs');

describe('workflow SHA pin verification', () => {
  it('passes on all repository workflows with 25 pinned uses steps', async () => {
    const result = await checkWorkflowPins();
    expect(result.ok).toBe(true);
    expect(result.workflowCount).toBe(4);
    expect(result.checkedCount).toBe(25);
    expect(result.violations).toEqual([]);
  });

  it('accepts lowercase 40-hex commit SHAs with # vX.Y.Z comments and sub-actions', () => {
    expect(
      validateUsesReference('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1'),
    ).toEqual({
      ok: true,
      local: false,
      action: 'actions/checkout',
      sha: '3d3c42e5aac5ba805825da76410c181273ba90b1',
      version: 'v7.0.1',
    });

    expect(
      validateUsesReference(
        "'github/codeql-action/init@33d7b85da1a04171e211befe2c739303b9a4c066' # v4.39.3",
      ),
    ).toEqual({
      ok: true,
      local: false,
      action: 'github/codeql-action/init',
      sha: '33d7b85da1a04171e211befe2c739303b9a4c066',
      version: 'v4.39.3',
    });
  });

  it('allows local ./ actions and reusable workflows without commit SHAs', () => {
    const workflow = [
      'name: Local action check',
      'jobs:',
      '  local-check:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: ./.github/actions/local-setup',
      "      - uses: './tools/custom-step' # local helper",
    ].join('\n');

    const result = auditWorkflowContent(workflow, '.github/workflows/local.yml');
    expect(result.checkedCount).toBe(2);
    expect(result.violations).toEqual([]);
  });

  it('flags mutable tags, branch refs, uppercase SHAs, and missing version comments with line numbers', () => {
    const workflow = [
      'name: Invalid pins',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v7',
      '      - uses: actions/setup-node@main',
      '      - uses: actions/setup-java@D1374F8AC74474200D16EF8ECEE22C7AE7A51880 # v6.3.0',
      '      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9',
      '      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8',
    ].join('\n');

    const result = auditWorkflowContent(workflow, '.github/workflows/ci.yml');
    expect(result.checkedCount).toBe(5);
    expect(result.violations.map((item) => item.line)).toEqual([6, 7, 8, 9, 10]);
    expect(formatPinViolations(result.violations)).toContain('.github/workflows/ci.yml:6');
    expect(formatPinViolations(result.violations)).toContain('.github/workflows/ci.yml:7');
  });

  it('ignores uses strings inside YAML block scalars and comments while rejecting multiline uses', () => {
    const workflow = [
      'name: Block scalar check',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      # uses: actions/checkout@v7',
      '      - name: Echo text',
      '        run: |',
      '          echo "uses: actions/checkout@v7"',
      '      - name: Multiline uses bypass attempt',
      '        uses: >-',
      '          actions/checkout@v7',
    ].join('\n');

    const result = auditWorkflowContent(workflow, '.github/workflows/scalar.yml');
    expect(result.checkedCount).toBe(1);
    expect(result.violations).toEqual([
      {
        filePath: '.github/workflows/scalar.yml',
        line: 11,
        reason: 'empty or multiline uses reference is not allowed',
      },
    ]);
  });

  it('audits both .yml and .yaml fixtures and exits with code 1 on @v7 or @main', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'turnleaf-workflow-pins-'));
    try {
      await writeFile(
        join(tempDir, 'tag.yml'),
        'jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v7\n',
      );
      await writeFile(
        join(tempDir, 'branch.yaml'),
        'jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/setup-node@main\n',
      );

      const cliResult = spawnSync(process.execPath, [scriptPath, tempDir], {
        encoding: 'utf8',
      });
      expect(cliResult.status).toBe(1);
      expect(cliResult.stderr).toContain('branch.yaml:5');
      expect(cliResult.stderr).toContain('tag.yml:5');

      const singleFileResult = spawnSync(process.execPath, [scriptPath, join(tempDir, 'tag.yml')], {
        encoding: 'utf8',
      });
      expect(singleFileResult.status).toBe(1);
      expect(singleFileResult.stderr).toContain('tag.yml:5');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
