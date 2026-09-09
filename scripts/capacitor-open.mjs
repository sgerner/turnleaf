import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, '..');
const supportedPlatforms = new Set(['android', 'ios']);

export function parseDotEnv(contents) {
  const values = {};

  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || match[1].startsWith('#')) continue;

    let value = match[2];
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }

  return values;
}

export function environmentWithOptionalDotEnv({
  env = process.env,
  envPath = join(projectRoot, '.env'),
} = {}) {
  let fileValues = {};
  try {
    fileValues = parseDotEnv(readFileSync(envPath, 'utf8'));
  } catch {
    // A .env file is optional; environment variables take precedence when present.
  }
  return { ...fileValues, ...env };
}

export function openPlatform(platform = process.argv[2]) {
  if (!supportedPlatforms.has(platform)) {
    throw new Error('Choose a Capacitor platform to open: android or ios.');
  }
  return platform;
}

export function runCapacitorOpen(platform, { env = environmentWithOptionalDotEnv() } = {}) {
  const executable = join(
    projectRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'cap.cmd' : 'cap',
  );

  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, ['open', platform], {
      cwd: projectRoot,
      env,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });

    child.once('error', rejectCommand);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveCommand();
        return;
      }
      rejectCommand(
        new Error(
          signal
            ? `Capacitor open terminated by ${signal}`
            : `Capacitor open exited with code ${code}`,
        ),
      );
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const platform = openPlatform();
  await runCapacitorOpen(platform).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
