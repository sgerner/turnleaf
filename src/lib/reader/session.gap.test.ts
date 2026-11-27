// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { defaultAppearance } from './appearance';
import { ReaderSession } from './session';

const { renderTo, rendition, manager } = vi.hoisted(() => {
  const managerObj = {
    settings: { gap: 0 },
    updateLayout: vi.fn(),
  };
  const renditionObj = {
    settings: { gap: 0 },
    manager: managerObj,
    hooks: { content: { register: vi.fn() } },
    on: vi.fn(),
    off: vi.fn(),
    started: Promise.resolve(),
    themes: { register: vi.fn(), select: vi.fn() },
    annotations: { highlight: vi.fn(), remove: vi.fn() },
    display: vi.fn(async () => {}),
    resize: vi.fn(),
    destroy: vi.fn(),
  };
  return {
    manager: managerObj,
    rendition: renditionObj,
    renderTo: vi.fn((_target: HTMLElement, options: { gap?: number }) => {
      renditionObj.settings.gap = options.gap ?? 0;
      managerObj.settings.gap = options.gap ?? 0;
      return renditionObj;
    }),
  };
});

vi.mock('epubjs', () => ({
  default: () => ({ renderTo, destroy: vi.fn() }),
}));

describe('ReaderSession column gap and body padding', () => {
  it('passes appearance.margin * 2 as gap on open and updates layout across 8px, 24px, and 56px margins', async () => {
    renderTo.mockClear();
    manager.updateLayout.mockClear();
    rendition.themes.register.mockClear();

    const viewport = document.createElement('div');
    const session = new ReaderSession('book.epub');

    await session.open(
      viewport,
      null,
      null,
      null,
      { ...defaultAppearance, margin: 24, bottomMargin: 32 },
      vi.fn(),
      vi.fn(),
    );

    expect(renderTo).toHaveBeenCalledWith(
      viewport,
      expect.objectContaining({
        width: '100%',
        height: '100%',
        gap: 48,
        flow: 'paginated',
        allowScriptedContent: false,
      }),
    );

    const registeredTheme = rendition.themes.register.mock.calls.at(-1)?.[1] as {
      body: Record<string, string>;
    };
    expect(registeredTheme.body['padding-top']).toBe('0.5rem !important');
    expect(registeredTheme.body['padding-bottom']).toBe('32px !important');
    expect(registeredTheme.body.padding).toBeUndefined();

    for (const margin of [8, 56, 24]) {
      session.applyAppearance({ ...defaultAppearance, margin });
      expect(rendition.settings.gap).toBe(margin * 2);
      expect(manager.settings.gap).toBe(margin * 2);
    }

    expect(manager.updateLayout).toHaveBeenCalledTimes(3);
    session.destroy();
  });
});
