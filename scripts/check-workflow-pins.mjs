import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultWorkflowsDir = join(projectRoot, '.github', 'workflows');

const ACTION_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const LOWERCASE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const VERSION_COMMENT_PATTERN = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const BLOCK_SCALAR_HEADER_PATTERN =
  /^(\s*(?:-\s+)?)(?!uses\s*:)[^:#\s][^:#]*:\s*[|>](?:[+-]|\d+[+-]?|[+-]\d+)?(?:\s+#.*)?$/;
const USES_LINE_PATTERN = /^(\s*(?:-\s+)?)uses\s*:(.*)$/;

function parseUsesRemainder(rawRemainder) {
  const trimmed = rawRemainder.trim();
  if (!trimmed || trimmed.startsWith('|') || trimmed.startsWith('>')) {
    return { refPart: '', commentPart: null };
  }

  if (trimmed.startsWith("'") || trimmed.startsWith('"')) {
    const quote = trimmed[0];
    const closingIndex = trimmed.indexOf(quote, 1);
    if (closingIndex === -1) {
      return { refPart: trimmed, commentPart: null, malformedQuote: true };
    }

    const refPart = trimmed.slice(1, closingIndex).trim();
    const afterQuote = trimmed.slice(closingIndex + 1).trim();
    if (!afterQuote) {
      return { refPart, commentPart: null };
    }
    if (!afterQuote.startsWith('#')) {
      return { refPart: trimmed, commentPart: null, malformedQuote: true };
    }
    return { refPart, commentPart: afterQuote.slice(1).trim() };
  }

  const commentMatch = /^(.*?)\s+#(.*)$/.exec(trimmed);
  if (commentMatch) {
    return {
      refPart: commentMatch[1].trim(),
      commentPart: commentMatch[2].trim(),
    };
  }

  return { refPart: trimmed, commentPart: null };
}

export function validateUsesReference(rawRemainder) {
  const { refPart, commentPart, malformedQuote } = parseUsesRemainder(rawRemainder);

  if (malformedQuote) {
    return { ok: false, reason: 'malformed quoted uses reference' };
  }

  if (!refPart) {
    return { ok: false, reason: 'empty or multiline uses reference is not allowed' };
  }

  if (/\s/.test(refPart)) {
    return { ok: false, reason: `unexpected whitespace in uses reference "${refPart}"` };
  }

  if (refPart.startsWith('./')) {
    if (refPart.length <= 2 || refPart.includes('@')) {
      return { ok: false, reason: `invalid local action path "${refPart}"` };
    }
    return { ok: true, local: true, refPart };
  }

  if (refPart.startsWith('docker://')) {
    return {
      ok: false,
      reason: `container action "${refPart}" is not pinned to a repository commit SHA`,
    };
  }

  const atIndex = refPart.indexOf('@');
  if (atIndex <= 0 || refPart.indexOf('@', atIndex + 1) !== -1) {
    return {
      ok: false,
      reason: `external action "${refPart}" must specify <owner>/<repo>@<40-char lowercase commit sha> # vX.Y.Z`,
    };
  }

  const actionSlug = refPart.slice(0, atIndex);
  const ref = refPart.slice(atIndex + 1);
  const segments = actionSlug.split('/');

  if (
    !ACTION_SLUG_PATTERN.test(actionSlug) ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    return { ok: false, reason: `invalid external action path "${actionSlug}"` };
  }

  if (!LOWERCASE_SHA_PATTERN.test(ref)) {
    return {
      ok: false,
      reason: `external action "${refPart}" must pin a lowercase 40-hex commit SHA instead of "${ref}"`,
    };
  }

  if (!commentPart || !VERSION_COMMENT_PATTERN.test(commentPart)) {
    return {
      ok: false,
      reason: `external action "${refPart}" must include a "# vX.Y.Z" version comment`,
    };
  }

  return {
    ok: true,
    local: false,
    action: actionSlug,
    sha: ref,
    version: commentPart,
  };
}

export function auditWorkflowContent(content, filePath = '<workflow>') {
  const lines = content.split(/\r?\n/);
  const violations = [];
  let checkedCount = 0;
  let blockScalarIndent = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const trimmed = line.trim();

    if (!trimmed) continue;

    const indent = /^\s*/.exec(line)[0].length;
    if (blockScalarIndent !== null) {
      if (indent > blockScalarIndent) {
        continue;
      }
      blockScalarIndent = null;
    }

    if (trimmed.startsWith('#')) continue;

    const blockScalarMatch = BLOCK_SCALAR_HEADER_PATTERN.exec(line);
    if (blockScalarMatch) {
      blockScalarIndent = blockScalarMatch[1].length;
      continue;
    }

    const usesMatch = USES_LINE_PATTERN.exec(line);
    if (!usesMatch) continue;

    checkedCount += 1;
    const validation = validateUsesReference(usesMatch[2]);
    if (!validation.ok) {
      violations.push({
        filePath,
        line: lineNumber,
        reason: validation.reason,
      });
    }
  }

  return { checkedCount, violations };
}

export async function checkWorkflowPins({
  workflowsDir = defaultWorkflowsDir,
  cwd = projectRoot,
} = {}) {
  const targetStats = await stat(workflowsDir);
  let workflowPaths;

  if (targetStats.isFile()) {
    workflowPaths = [workflowsDir];
  } else {
    const entries = await readdir(workflowsDir, { withFileTypes: true });
    workflowPaths = entries
      .filter((entry) => entry.isFile() && /\.(?:yml|yaml)$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .map((fileName) => join(workflowsDir, fileName));
  }

  if (workflowPaths.length === 0) {
    throw new Error(`No workflow files (*.yml, *.yaml) found in ${workflowsDir}`);
  }

  let totalChecked = 0;
  const violations = [];

  for (const absolutePath of workflowPaths) {
    const relativePath = relative(cwd, absolutePath);
    const displayPath =
      relativePath && !relativePath.startsWith('..') ? relativePath : basename(absolutePath);
    const content = await readFile(absolutePath, 'utf8');
    const result = auditWorkflowContent(content, displayPath);
    totalChecked += result.checkedCount;
    violations.push(...result.violations);
  }

  return {
    ok: violations.length === 0,
    workflowCount: workflowPaths.length,
    checkedCount: totalChecked,
    violations,
  };
}

export function formatPinViolations(violations) {
  return [
    'Unpinned or invalid GitHub Actions workflow references detected:',
    ...violations.map(
      (violation) => `  - ${violation.filePath}:${violation.line}: ${violation.reason}`,
    ),
  ].join('\n');
}

export async function runCli(argv = process.argv.slice(2)) {
  const rawTarget = argv[0] === '--workflows-dir' ? argv[1] : argv[0];
  const targetPath = rawTarget ? resolve(rawTarget) : defaultWorkflowsDir;
  const cwd = rawTarget ? dirname(targetPath) : projectRoot;
  const result = await checkWorkflowPins({ workflowsDir: targetPath, cwd });

  if (!result.ok) {
    throw new Error(formatPinViolations(result.violations));
  }

  console.log(
    `Verified ${result.checkedCount} workflow uses step(s) across ${result.workflowCount} workflow file(s).`,
  );
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
