// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forwardStageScrollKey } from './stage-scroll';

describe('forwardStageScrollKey', () => {
  let stage: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    stage = document.createElement('div');
    stage.className = 'app-stage';
    Object.defineProperty(stage, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(stage, 'scrollHeight', { value: 1600, configurable: true });
    stage.scrollTop = 0;
    document.body.append(stage);
    document.body.focus();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  function pressKey(
    key: string,
    init: KeyboardEventInit = {},
    target: EventTarget = document.body,
  ): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    target.dispatchEvent(event);
    forwardStageScrollKey(event, stage);
    return event;
  }

  it('moves .app-stage.scrollTop for PageDown, PageUp, Space, Shift+Space, ArrowDown, ArrowUp, Home, and End on body focus', () => {
    expect(document.activeElement).toBe(document.body);

    const pageDown = pressKey('PageDown');
    expect(pageDown.defaultPrevented).toBe(true);
    expect(stage.scrollTop).toBe(350);

    const pageUp = pressKey('PageUp');
    expect(pageUp.defaultPrevented).toBe(true);
    expect(stage.scrollTop).toBe(0);

    const space = pressKey(' ');
    expect(space.defaultPrevented).toBe(true);
    expect(stage.scrollTop).toBe(350);

    const shiftSpace = pressKey(' ', { shiftKey: true });
    expect(shiftSpace.defaultPrevented).toBe(true);
    expect(stage.scrollTop).toBe(0);

    const arrowDown = pressKey('ArrowDown');
    expect(arrowDown.defaultPrevented).toBe(true);
    expect(stage.scrollTop).toBe(40);

    const arrowUp = pressKey('ArrowUp');
    expect(arrowUp.defaultPrevented).toBe(true);
    expect(stage.scrollTop).toBe(0);

    const end = pressKey('End');
    expect(end.defaultPrevented).toBe(true);
    expect(stage.scrollTop).toBe(1200);

    const home = pressKey('Home');
    expect(home.defaultPrevented).toBe(true);
    expect(stage.scrollTop).toBe(0);
  });

  it('honors prefers-reduced-motion when scrollBy and scrollTo are available', () => {
    const scrollBy = vi.fn();
    const scrollTo = vi.fn();
    Object.assign(stage, { scrollBy, scrollTo });

    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: false,
        media: query,
      })),
    );
    pressKey('PageDown');
    pressKey('End');
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 350, behavior: 'smooth' });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1200, behavior: 'smooth' });

    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
      })),
    );
    pressKey('ArrowDown');
    pressKey('Home');
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 40, behavior: 'auto' });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'auto' });
  });

  it('suppresses forwarding during active reading, open dialogs, focused inputs, and modifier keys', () => {
    const input = document.createElement('input');
    stage.append(input);
    input.focus();
    const onInput = pressKey('PageDown', {}, input);
    expect(onInput.defaultPrevented).toBe(false);
    expect(stage.scrollTop).toBe(0);

    input.blur();
    expect(document.activeElement).toBe(document.body);

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.append(dialog);
    const withDialog = pressKey('PageDown');
    expect(withDialog.defaultPrevented).toBe(false);
    expect(stage.scrollTop).toBe(0);
    dialog.remove();

    const reader = document.createElement('main');
    reader.className = 'reader-shell';
    stage.append(reader);
    const withReader = pressKey('ArrowDown');
    expect(withReader.defaultPrevented).toBe(false);
    expect(stage.scrollTop).toBe(0);
    reader.remove();

    for (const mod of [
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { shiftKey: true },
    ]) {
      const modified = pressKey('ArrowDown', mod);
      expect(modified.defaultPrevented).toBe(false);
      expect(stage.scrollTop).toBe(0);
    }
  });
});
