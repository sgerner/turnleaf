import { describe, expect, it } from 'vitest';
import { installLegacyWebViewShims } from './compat';

describe('legacy Android WebView compatibility shims', () => {
  it('provides spec-compatible AggregateError and AbortSignal.any on legacy targets', () => {
    const fakeGlobal: Record<string, unknown> = {
      AbortSignal: function FakeAbortSignal() {} as unknown as typeof AbortSignal,
    };
    installLegacyWebViewShims(fakeGlobal);

    const AggregateCtor = fakeGlobal.AggregateError as {
      new (errors: unknown[], message?: string): Error & { errors: unknown[] };
      (errors: unknown[], message?: string): Error & { errors: unknown[] };
    };
    const constructed = new AggregateCtor([new Error('first')], 'combined');
    const invoked = AggregateCtor(['second'], 'invoked');
    expect(constructed).toBeInstanceOf(Error);
    expect(constructed.errors).toHaveLength(1);
    expect(invoked.message).toBe('invoked');
    expect(invoked.errors).toEqual(['second']);

    const anyFn = (fakeGlobal.AbortSignal as { any: (signals: AbortSignal[]) => AbortSignal }).any;
    const first = new AbortController();
    const second = new AbortController();
    const combined = anyFn([first.signal, second.signal]);
    expect(combined.aborted).toBe(false);
    second.abort();
    expect(combined.aborted).toBe(true);
  });
});
