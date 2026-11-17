import { describe, expect, it } from 'vitest';
import { runCleanup } from './android-cleanup.mjs';

describe('Android journey cleanup', () => {
  it('retries a failed step once and runs steps sequentially', async () => {
    const order = [];
    let attempts = 0;
    const failures = await runCleanup(
      [
        [
          'restore Wi-Fi',
          async () => {
            order.push('wifi');
            if (++attempts === 1) throw new Error('temporary ADB fault');
          },
        ],
        ['restore data', async () => order.push('data')],
      ],
      { retryDelayMs: 0 },
    );

    expect(failures).toEqual([]);
    expect(order).toEqual(['wifi', 'wifi', 'data']);
  });

  it('reports persistent cleanup failure and still runs later steps', async () => {
    const order = [];
    const failures = await runCleanup(
      [
        [
          'remove reverse tunnel',
          async () => {
            order.push('reverse');
            throw new Error('protocol fault');
          },
        ],
        ['close fixture', async () => order.push('fixture')],
      ],
      { retryDelayMs: 0 },
    );

    expect(failures).toEqual(['remove reverse tunnel: protocol fault']);
    expect(order).toEqual(['reverse', 'reverse', 'fixture']);
  });
});
