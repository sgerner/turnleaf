// @vitest-environment jsdom

import type { Rendition } from 'epubjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ViewportResizeController } from './viewport-resize';

function createQueuedRendition() {
  const rawManagerResize = vi.fn();
  const listeners = new Map<string, Set<() => void>>();
  const rendition = {
    location: undefined as { start?: { cfi?: string } } | undefined,
    manager: {
      isRendered: vi.fn(() => true),
      resize: rawManagerResize,
    },
    q: {
      running: false as unknown,
      length: vi.fn(() => 0),
      enqueue: vi.fn((task: () => Promise<void>) => task()),
    },
    on: vi.fn((event: string, cb: () => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(cb);
    }),
    off: vi.fn((event: string, cb: () => void) => {
      listeners.get(event)?.delete(cb);
    }),
    resize: vi.fn((width: number, height: number, cfi?: string) => {
      rendition.manager.resize(width, height, cfi);
    }),
    emit: (event: string) => {
      for (const cb of listeners.get(event) ?? []) cb();
    },
  };
  return { rendition, rawManagerResize };
}

describe('ViewportResizeController', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('defers resizes arriving after navigation resolves until relocation settles on the next animation frame', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    const { rendition, rawManagerResize } = createQueuedRendition();
    const viewport = document.createElement('div');
    let currentRect = new DOMRect(0, 0, 411, 842);
    vi.spyOn(viewport, 'getBoundingClientRect').mockImplementation(() => currentRect);

    let currentCfi: string | null = 'epubcfi(/6/2!/4/2/1:0)';
    rendition.location = { start: { cfi: currentCfi } };

    const controller = new ViewportResizeController(
      viewport,
      rendition as unknown as Rendition,
      () => currentCfi,
    );
    controller.notifyRelocated();

    // Simulate epub.js next()/display() resolving BEFORE requestAnimationFrame updates rendition.location
    await controller.trackOperation(async () => {
      await Promise.resolve();
    });

    // System bar / Stage window resize arrives before reportedLocationAfterRAF fires
    currentRect = new DOMRect(0, 0, 411, 914);
    rendition.manager.resize();
    resizeCallbacks[0]?.(
      [{ contentRect: { width: 411, height: 914 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );

    expect(rendition.resize).not.toHaveBeenCalled();
    expect(rawManagerResize).not.toHaveBeenCalled();

    // Once reportedLocationAfterRAF updates location to Chapter 2 and emits 'relocated', flush runs safely
    currentCfi = 'epubcfi(/6/4!/4/2/1:0)';
    rendition.location = { start: { cfi: currentCfi } };
    controller.notifyRelocated();

    await vi.waitFor(() => {
      expect(rendition.resize).toHaveBeenCalledExactlyOnceWith(411, 914);
    });
    expect(rawManagerResize).toHaveBeenCalledExactlyOnceWith(411, 914, undefined);
    controller.destroy();
  });

  it('flushes deferred resizes via fallback timeout when a boundary turn emits no relocated event', async () => {
    vi.useFakeTimers();
    const { rendition, rawManagerResize } = createQueuedRendition();
    const viewport = document.createElement('div');
    let currentRect = new DOMRect(0, 0, 411, 842);
    vi.spyOn(viewport, 'getBoundingClientRect').mockImplementation(() => currentRect);

    const currentCfi = 'epubcfi(/6/4!/4/2/1:0)';
    rendition.location = { start: { cfi: currentCfi } };

    const controller = new ViewportResizeController(
      viewport,
      rendition as unknown as Rendition,
      () => currentCfi,
    );
    controller.notifyRelocated();

    await controller.trackOperation(async () => {});

    currentRect = new DOMRect(0, 0, 411, 900);
    rendition.manager.resize();
    expect(rendition.resize).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(550);

    expect(rendition.resize).toHaveBeenCalledExactlyOnceWith(411, 900);
    expect(rawManagerResize).toHaveBeenCalledExactlyOnceWith(411, 900, undefined);
    controller.destroy();
  });

  it('cancels pending resizes and detaches listeners on destroy', async () => {
    vi.useFakeTimers();
    const disconnect = vi.fn();
    class TestResizeObserver {
      observe(): void {}
      disconnect(): void {
        disconnect();
      }
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    const { rendition, rawManagerResize } = createQueuedRendition();
    const viewport = document.createElement('div');
    let currentRect = new DOMRect(0, 0, 411, 842);
    vi.spyOn(viewport, 'getBoundingClientRect').mockImplementation(() => currentRect);

    rendition.location = { start: { cfi: 'epubcfi(/6/2!/4/2/1:0)' } };
    const controller = new ViewportResizeController(
      viewport,
      rendition as unknown as Rendition,
      () => 'epubcfi(/6/2!/4/2/1:0)',
    );

    await controller.trackOperation(async () => {});
    currentRect = new DOMRect(0, 0, 411, 900);
    rendition.manager.resize();

    controller.destroy();
    await vi.advanceTimersByTimeAsync(600);

    expect(disconnect).toHaveBeenCalledOnce();
    expect(rendition.off).toHaveBeenCalledWith('started', expect.any(Function));
    expect(rendition.resize).not.toHaveBeenCalled();
    expect(rawManagerResize).not.toHaveBeenCalled();
  });
});
