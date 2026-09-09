import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function npmExecutable(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function auditArguments(userConfigPath) {
  return ['audit', '--omit=dev', '--ignore-scripts', '--userconfig', userConfigPath];
}

export async function runAudit({ spawnImpl = spawn, cwd = projectRoot } = {}) {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'turnleaf-npm-audit-'));
  const userConfigPath = join(tempDirectory, 'empty.npmrc');
  await writeFile(userConfigPath, '');
  const env = { ...process.env };
  delete env.npm_config_allow_scripts;
  delete env.npm_config_strict_allow_scripts;
  env.npm_config_userconfig = userConfigPath;

  try {
    await new Promise((resolveCommand, rejectCommand) => {
      const child = spawnImpl(npmExecutable(), auditArguments(userConfigPath), {
        cwd,
        env,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });

      child.once('error', rejectCommand);
      child.once('exit', (code, signal) => {
        if (code === 0) {
          resolveCommand();
          return;
        }
        rejectCommand(
          new Error(
            signal ? `npm audit terminated by ${signal}` : `npm audit exited with code ${code}`,
          ),
        );
      });
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runAudit().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
