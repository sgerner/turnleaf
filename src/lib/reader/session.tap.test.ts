import type { Contents } from 'epubjs';
import { expect, it, vi } from 'vitest';
import { defaultAppearance } from './appearance';
import { ReaderSession } from './session';

const { rendition } = vi.hoisted(() => ({
  rendition: {
    hooks: { content: { register: vi.fn() } },
    on: vi.fn(),
    off: vi.fn(),
    started: Promise.resolve(),
    themes: { register: vi.fn(), select: vi.fn() },
    display: vi.fn(async () => {}),
    destroy: vi.fn(),
  },
}));

vi.mock('epubjs', () => ({
  default: () => ({ renderTo: () => rendition, destroy: vi.fn() }),
}));

it('keeps the tap zones in the same places as the EPUB iframe scrolls', async () => {
  const viewport = document.createElement('div');
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 0, 300, 400));
  const frame = document.createElement('iframe');
  const frameRect = vi.spyOn(frame, 'getBoundingClientRect');
  const contents = {
    window: { frameElement: frame, innerWidth: 1200, getSelection: () => null },
  } as unknown as Contents;
  const onTap = vi.fn();
  const session = new ReaderSession('book.epub');
  await session.open(viewport, null, null, null, defaultAppearance, vi.fn(), onTap);
  const click = rendition.on.mock.calls.find(([event]) => event === 'click')?.[1];

  for (const offset of [0, 300, 600, 900]) {
    frameRect.mockReturnValue(new DOMRect(20 - offset, 0, 1200, 400));
    for (const x of [20, 150, 280]) {
      click(new MouseEvent('click', { clientX: offset + x }), contents);
    }
  }

  expect(onTap.mock.calls).toEqual(
    Array.from({ length: 4 }, () => [['previous'], ['center'], ['next']]).flat(),
  );
  session.destroy();
});
