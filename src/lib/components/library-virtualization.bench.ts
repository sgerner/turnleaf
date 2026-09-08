import { bench, describe } from 'vitest';
import { calculateVirtualWindow } from './library-virtualization';

const datasetSizes = [500, 5_000, 10_000];
const scrollPositions = [0, 1_234, 250_000, 1_000_000];

describe('library virtualization baseline', () => {
  for (const itemCount of datasetSizes) {
    bench(`${itemCount.toLocaleString()} books`, () => {
      for (const scrollTop of scrollPositions) {
        calculateVirtualWindow(itemCount, 5, 420, scrollTop, 900, 2);
      }
    });
  }
});
