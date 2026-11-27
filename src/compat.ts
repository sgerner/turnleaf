function defineMethod(target: object, name: PropertyKey, value: unknown): void {
  if (!(name in target)) {
    Object.defineProperty(target, name, { value, configurable: true, writable: true });
  }
}

export function installLegacyWebViewShims(target: Record<string, unknown> = globalThis): void {
  defineMethod(Object, 'hasOwn', (object: object, property: PropertyKey): boolean =>
    Object.prototype.hasOwnProperty.call(Object(object), property),
  );

  defineMethod(
    Object,
    'fromEntries',
    (entries: Iterable<readonly [PropertyKey, unknown]>): Record<PropertyKey, unknown> => {
      const result: Record<PropertyKey, unknown> = {};
      for (const [key, value] of entries) result[key] = value;
      return result;
    },
  );

  defineMethod(
    String.prototype,
    'replaceAll',
    function (
      this: string,
      searchValue: string | RegExp,
      replaceValue: string | ((substring: string, ...args: unknown[]) => string),
    ): string {
      const source = String(this);
      if (searchValue instanceof RegExp) {
        if (!searchValue.flags.includes('g')) {
          throw new TypeError('String.prototype.replaceAll called with a non-global RegExp');
        }
        return source.replace(searchValue, replaceValue as never);
      }
      const needle = String(searchValue);
      const parts = source.split(needle);
      if (typeof replaceValue !== 'function') {
        const replacement = String(replaceValue);
        return needle === ''
          ? replacement + parts.join(replacement) + replacement
          : parts.join(replacement);
      }
      if (needle === '') {
        let output = replaceValue('', 0, source);
        for (let index = 0; index < source.length; index += 1) {
          output += source[index]! + replaceValue('', index + 1, source);
        }
        return output;
      }
      let output = parts[0]!;
      let offset = output.length;
      for (let index = 1; index < parts.length; index += 1) {
        output += replaceValue(needle, offset, source) + parts[index]!;
        offset += needle.length + parts[index]!.length;
      }
      return output;
    },
  );

  for (const proto of [Array.prototype, String.prototype, Uint8Array.prototype]) {
    defineMethod(proto, 'at', function (this: ArrayLike<unknown>, index: number): unknown {
      const length = this.length >>> 0;
      const integer = Math.trunc(Number(index)) || 0;
      const resolved = integer < 0 ? length + integer : integer;
      return resolved >= 0 && resolved < length ? this[resolved] : undefined;
    });
  }

  defineMethod(Promise, 'allSettled', <T>(values: Iterable<T | PromiseLike<T>>) =>
    Promise.all(
      Array.from(values, (item) =>
        Promise.resolve(item).then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (reason: unknown) => ({ status: 'rejected' as const, reason }),
        ),
      ),
    ),
  );

  if (typeof target.AggregateError !== 'function') {
    const AggregateErrorShim = function AggregateError(
      this: unknown,
      errors: Iterable<unknown>,
      message = '',
    ) {
      const instance = Object.setPrototypeOf(
        new Error(message),
        AggregateErrorShim.prototype,
      ) as Error & { errors: unknown[] };
      instance.name = 'AggregateError';
      instance.errors = Array.from(errors);
      return instance;
    };
    AggregateErrorShim.prototype = Object.create(Error.prototype);
    AggregateErrorShim.prototype.constructor = AggregateErrorShim;
    target.AggregateError = AggregateErrorShim;
  }

  target.queueMicrotask ??= (callback: () => void) => {
    void Promise.resolve().then(callback);
  };

  const abortSignalCtor = target.AbortSignal as
    (typeof AbortSignal & { any?: (signals: AbortSignal[]) => AbortSignal }) | undefined;
  if (abortSignalCtor && typeof abortSignalCtor.any !== 'function') {
    abortSignalCtor.any = (signals: AbortSignal[]): AbortSignal => {
      const controller = new AbortController();
      for (const signal of signals) {
        if (signal.aborted) {
          controller.abort();
          break;
        }
        signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
      return controller.signal;
    };
  }
}

installLegacyWebViewShims();
