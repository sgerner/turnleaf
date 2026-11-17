import { spawn } from 'node:child_process';

export function runCommand(command, args, { label = command, spawnImpl = spawn, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      ...options,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(
        signal ? `${label} terminated by ${signal}` : `${label} exited with code ${code}`,
      );
      error.exitCode = code ?? 1;
      reject(error);
    });
  });
}
