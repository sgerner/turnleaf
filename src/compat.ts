export function installLegacyWebViewShims(target: Record<string, unknown> = globalThis): void {
  const objectStatic = Object as unknown as Record<string, unknown>;
  if (typeof objectStatic.hasOwn !== 'function') {
    Object.defineProperty(Object, 'hasOwn', {
      value(object: object, property: PropertyKey): boolean {
        return Object.prototype.hasOwnProperty.call(Object(object), property);
      },
      configurable: true,
      writable: true,
    });
  }

  if (typeof objectStatic.fromEntries !== 'function') {
    Object.defineProperty(Object, 'fromEntries', {
      value(entries: Iterable<readonly [PropertyKey, unknown]>): Record<PropertyKey, unknown> {
        const result: Record<PropertyKey, unknown> = {};
        for (const [key, value] of entries) {
          result[key] = value;
        }
        return result;
      },
      configurable: true,
      writable: true,
    });
  }

  if (!('replaceAll' in String.prototype)) {
    Object.defineProperty(String.prototype, 'replaceAll', {
      value(
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
        if (typeof replaceValue === 'function') {
          if (needle === '') {
            let output = replaceValue('', 0, source);
            for (let index = 0; index < source.length; index += 1) {
              output += source[index]! + replaceValue('', index + 1, source);
            }
            return output;
          }
          let output = '';
          let cursor = 0;
          while (cursor <= source.length) {
            const matchIndex = source.indexOf(needle, cursor);
            if (matchIndex === -1) {
              output += source.slice(cursor);
              break;
            }
            output += source.slice(cursor, matchIndex) + replaceValue(needle, matchIndex, source);
            cursor = matchIndex + needle.length;
          }
          return output;
        }
        const replacement = String(replaceValue);
        if (needle === '') {
          return replacement + source.split('').join(replacement) + replacement;
        }
        return source.split(needle).join(replacement);
      },
      configurable: true,
      writable: true,
    });
  }

  const indexablePrototypes: Array<{ length?: number } & Record<PropertyKey, unknown>> = [
    Array.prototype as unknown as { length?: number } & Record<PropertyKey, unknown>,
    String.prototype as unknown as { length?: number } & Record<PropertyKey, unknown>,
    Uint8Array.prototype as unknown as { length?: number } & Record<PropertyKey, unknown>,
  ];
  for (const proto of indexablePrototypes) {
    if (!('at' in proto)) {
      Object.defineProperty(proto, 'at', {
        value(this: ArrayLike<unknown>, index: number): unknown {
          const length = this.length >>> 0;
          const integer = Math.trunc(Number(index)) || 0;
          const resolved = integer < 0 ? length + integer : integer;
          if (resolved < 0 || resolved >= length) return undefined;
          return this[resolved];
        },
        configurable: true,
        writable: true,
      });
    }
  }

  if (!('allSettled' in Promise)) {
    Object.defineProperty(Promise, 'allSettled', {
      value<T>(values: Iterable<T | PromiseLike<T>>) {
        return Promise.all(
          Array.from(values, (item) =>
            Promise.resolve(item).then(
              (value) => ({ status: 'fulfilled' as const, value }),
              (reason: unknown) => ({ status: 'rejected' as const, reason }),
            ),
          ),
        );
      },
      configurable: true,
      writable: true,
    });
  }

  if (typeof target.AggregateError !== 'function') {
    const AggregateErrorShim = function AggregateError(
      this: unknown,
      errors: Iterable<unknown>,
      message = '',
    ) {
      const instance = new Error(message) as Error & { errors: unknown[] };
      Object.setPrototypeOf(instance, AggregateErrorShim.prototype);
      instance.name = 'AggregateError';
      instance.errors = Array.from(errors);
      return instance;
    };
    AggregateErrorShim.prototype = Object.create(Error.prototype);
    AggregateErrorShim.prototype.constructor = AggregateErrorShim;
    target.AggregateError = AggregateErrorShim;
  }

  if (typeof target.queueMicrotask !== 'function') {
    target.queueMicrotask = (callback: () => void) => {
      void Promise.resolve().then(callback);
    };
  }

  const abortSignalCtor = target.AbortSignal as
    (typeof AbortSignal & { any?: (signals: AbortSignal[]) => AbortSignal }) | undefined;
  if (abortSignalCtor && typeof abortSignalCtor.any !== 'function') {
    abortSignalCtor.any = (signals: AbortSignal[]): AbortSignal => {
      const controller = new AbortController();
      for (const signal of signals) {
        if (signal.aborted) {
          controller.abort();
          return controller.signal;
        }
        signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
      return controller.signal;
    };
  }
}

installLegacyWebViewShims();
