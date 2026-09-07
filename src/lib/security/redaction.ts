const SECRET_VALUE = '[redacted]';

const SECRET_FIELDS = /\b(apiKey|api_key|x-api-key|authorization|auth|token|password)\b/i;

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    let changed = false;
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_FIELDS.test(key)) {
        url.searchParams.set(key, SECRET_VALUE);
        changed = true;
      }
    }
    return changed ? url.toString() : value;
  } catch {
    return value;
  }
}

export function redactDiagnosticValue(value: unknown): unknown {
  if (typeof value === 'string') return redactUrl(value);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactDiagnosticValue);

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SECRET_FIELDS.test(key) ? SECRET_VALUE : redactDiagnosticValue(entry),
    ]),
  );
}

export function redactDiagnosticText(value: string): string {
  return value
    .replace(/([?&](?:apiKey|api_key|auth|token|password)=)[^&#\s]+/gi, `$1${SECRET_VALUE}`)
    .replace(
      /(?<![?&])\b(apiKey|api_key|x-api-key|authorization|auth|token|password)\b\s*[:=]\s*["']?[^"',\s}]+/gi,
      (_match, key: string) => `${key}: ${SECRET_VALUE}`,
    );
}
