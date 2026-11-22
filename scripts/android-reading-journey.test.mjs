import { describe, expect, it } from 'vitest';
import { validateEpubArchive } from '../src/lib/downloads/epub-validation';
import { createJourneyEpub, startFixture } from './android-reading-journey.mjs';

describe('Android reading journey hostile EPUB fixture', () => {
  it('builds a valid EPUB containing all 5 hostile subresource vectors and records unauthenticated leaks', async () => {
    const fixture = await startFixture();
    try {
      const epub = createJourneyEpub(`http://127.0.0.1:${fixture.port}/hostile`);
      await expect(
        validateEpubArchive(epub.length, async (offset, length) =>
          epub.subarray(offset, offset + length),
        ),
      ).resolves.toBeUndefined();

      const archiveText = epub.toString('utf8');
      expect(archiveText).toContain('/hostile/img-src.png');
      expect(archiveText).toContain('/hostile/img-srcset.png');
      expect(archiveText).toContain('/hostile/svg-image.png');
      expect(archiveText).toContain('/hostile/video-poster.png');
      expect(archiveText).toContain('/hostile/inline-bg.png');
      expect(archiveText).toContain('/hostile/packaged-bg.png');
      expect(archiveText).toContain('/hostile/packaged-import.css');
      expect(fixture.hostileRequests).toEqual([]);

      const simulatedLeak = await fetch(`http://127.0.0.1:${fixture.port}/hostile/img-src.png`);
      expect(simulatedLeak.status).toBe(204);
      expect(fixture.hostileRequests).toEqual(['/hostile/img-src.png']);
    } finally {
      fixture.close();
    }
  });
});
