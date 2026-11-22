// @vitest-environment jsdom

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
    themes: { registerCss: vi.fn(), select: vi.fn() },
    annotations: { highlight: vi.fn(), remove: vi.fn() },
    display: vi.fn(async () => {}),
    resize: vi.fn(),
    destroy: vi.fn(),
  },
}));

vi.mock('epubjs', () => ({
  default: () => ({ renderTo: () => rendition, destroy: vi.fn() }),
}));

it('keeps the tap zones in the same places as the EPUB iframe scrolls', async () => {
  rendition.on.mockClear();
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

it('measures tap zones against the outer .reader-shell when .reader-viewport is inset', async () => {
  rendition.on.mockClear();
  const shell = document.createElement('main');
  shell.className = 'reader-shell';
  const viewport = document.createElement('div');
  viewport.className = 'reader-viewport';
  shell.append(viewport);
  vi.spyOn(shell, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 390, 844));
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(56, 8, 278, 772));

  const frame = document.createElement('iframe');
  vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(new DOMRect(56, 8, 1112, 772));
  const contents = {
    window: { frameElement: frame, innerWidth: 1112, getSelection: () => null },
  } as unknown as Contents;
  const onTap = vi.fn();
  const session = new ReaderSession('book.epub');
  await session.open(viewport, null, null, null, defaultAppearance, vi.fn(), onTap);
  const click = rendition.on.mock.calls.find(([event]) => event === 'click')?.[1];

  // Screen x = 56 + 60 = 116 (< 0.33 * 390 = 128.7 => previous, even though 60 / 278 = 0.215)
  // Screen x = 56 + 80 = 136 (between 128.7 and 261.3 => center, whereas 80 / 278 = 0.287 would have been previous)
  // Screen x = 56 + 215 = 271 (> 0.67 * 390 = 261.3 => next)
  for (const clientX of [60, 80, 215]) {
    click(new MouseEvent('click', { clientX }), contents);
  }

  expect(onTap.mock.calls).toEqual([['previous'], ['center'], ['next']]);
  session.destroy();
});
