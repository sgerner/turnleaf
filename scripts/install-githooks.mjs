import { execFileSync } from 'node:child_process';

function main() {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
  } catch {
    // Ignore environments without git or without a writable repo config.
  }
}

main();
