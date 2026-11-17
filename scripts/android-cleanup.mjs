import { setTimeout as delay } from 'node:timers/promises';

export async function runCleanup(actions, { retryDelayMs = 250 } = {}) {
  const failures = [];
  for (const [label, action] of actions) {
    let failure;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await action();
        failure = undefined;
        break;
      } catch (error) {
        failure = error;
        if (attempt === 0) await delay(retryDelayMs);
      }
    }
    if (failure) failures.push(`${label}: ${failure.message ?? failure}`);
  }
  return failures;
}
