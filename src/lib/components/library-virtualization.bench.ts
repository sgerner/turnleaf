import { test } from 'vitest';
import { calculateVirtualWindow } from './library-virtualization';

const datasetSizes = [500, 5_000, 10_000];
const scrollPositions = [0, 1_234, 250_000, 1_000_000];

test('library virtualization baseline', async ({ bench }) => {
  for (const itemCount of datasetSizes) {
    await bench(`${itemCount.toLocaleString()} books`, () => {
      for (const scrollTop of scrollPositions) {
        calculateVirtualWindow(itemCount, 5, 420, scrollTop, 900, 2);
      }
    }).run();
  }
});
