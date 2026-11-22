// @vitest-environment jsdom

import type { Rendition } from 'epubjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ViewportResizeController } from './viewport-resize';

function createQueuedRenditionHarness() {
  const listeners = new Map<string, Set<() => void>>();
  const queuedTasks: Array<() => Promise<void> | void> = [];
  let rendered = false;
  let managerReady = false;
  const managerResize = vi.fn();

  const manager = {
    isRendered: () => rendered,
    resize: (...args: unknown[]) => managerResize(...args),
  };

  const q = {
    running: undefined as boolean | undefined,
    length: () => queuedTasks.length,
    enqueue: vi.fn((task: () => Promise<void>) => {
      queuedTasks.push(task);
      q.running = true;
      return Promise.resolve().then(async () => {
        while (queuedTasks.length > 0) {
          const next = queuedTasks.shift()!;
          await next();
        }
        // Match EPUB.js Queue.run(), where q.running stays truthy until the next frame tick.
        queueMicrotask(() => {
          if (queuedTasks.length === 0) q.running = undefined;
        });
      });
    }),
  };

  const rendition = {
    location: undefined as { start?: { cfi?: string } } | undefined,
    get manager() {
      return managerReady ? manager : undefined;
    },
    q,
    on: vi.fn((event: string, cb: () => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
    }),
    off: vi.fn((event: string, cb: () => void) => {
      listeners.get(event)?.delete(cb);
    }),
    resize: vi.fn((width: number, height: number, epubcfi?: string) => {
      if (!managerReady) {
        throw new TypeError("Cannot read properties of undefined (reading 'resize')");
      }
      if (!rendered) {
        throw new TypeError("Cannot read properties of undefined (reading 'size')");
      }
      manager.resize(width, height, epubcfi);
    }),
  };

  return {
    rendition: rendition as unknown as Rendition,
    runtime: rendition,
    manager,
    managerResize,
    emitStarted() {
      managerReady = true;
      for (const cb of listeners.get('started') ?? []) cb();
    },
    setRendered(value: boolean) {
      rendered = value;
    },
  };
}

function stubResizeObserver() {
  const callbacks: ResizeObserverCallback[] = [];
  const disconnect = vi.fn();
  class MockResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      callbacks.push(callback);
    }
    observe(): void {}
    disconnect(): void {
      disconnect();
    }
  }
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  return {
    disconnect,
    trigger(width: number, height: number) {
      callbacks[0]?.(
        [{ contentRect: { width, height } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    },
  };
}

describe('ViewportResizeController', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defers ResizeObserver events fired before rendition startup and stage attachment', async () => {
    const observer = stubResizeObserver();
    const harness = createQueuedRenditionHarness();
    const target = document.createElement('div');
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 412, 840));
    let currentCfi: string | null = null;

    const controller = new ViewportResizeController(target, harness.rendition, () => currentCfi);

    await controller.trackOperation(async () => {
      // Fires before rendition.started (manager is still undefined).
      expect(() => observer.trigger(412, 880)).not.toThrow();
      harness.emitStarted();
      // Fires after started but before attachTo renders the stage.
      expect(() => observer.trigger(412, 915)).not.toThrow();
      harness.setRendered(true);
    });

    // Still waiting for initial location reporting before clearing/resizing views.
    expect(harness.managerResize).not.toHaveBeenCalled();

    currentCfi = 'epubcfi(/6/2!/4/2/1:0)';
    controller.notifyRelocated();
    await vi.waitFor(() => {
      expect(harness.managerResize).toHaveBeenCalledExactlyOnceWith(
        412,
        915,
        'epubcfi(/6/2!/4/2/1:0)',
      );
    });

    controller.destroy();
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });

  it('intercepts uncoordinated EPUB.js manager.resize calls during display and deduplicates settled sizes', async () => {
    const observer = stubResizeObserver();
    const harness = createQueuedRenditionHarness();
    harness.emitStarted();
    harness.setRendered(true);

    const target = document.createElement('div');
    let currentRect = new DOMRect(0, 0, 412, 840);
    vi.spyOn(target, 'getBoundingClientRect').mockImplementation(() => currentRect);
    let currentCfi: string | null = null;

    const controller = new ViewportResizeController(target, harness.rendition, () => currentCfi);

    await controller.trackOperation(async () => {
      currentRect = new DOMRect(0, 0, 412, 915);
      // Simulate EPUB.js Stage's 50ms window resize listener calling manager.resize() directly.
      harness.manager.resize();
      expect(harness.managerResize).not.toHaveBeenCalled();
    });

    harness.runtime.location = { start: { cfi: 'epubcfi(/6/4!/4/2/1:0)' } };
    currentCfi = 'epubcfi(/6/4!/4/2/1:0)';
    controller.notifyRelocated();

    await vi.waitFor(() => {
      expect(harness.managerResize).toHaveBeenCalledExactlyOnceWith(412, 915, undefined);
    });

    // Subsequent duplicate ResizeObserver / Stage window resize at the same dimensions is ignored.
    observer.trigger(412, 915);
    harness.manager.resize();
    expect(harness.managerResize).toHaveBeenCalledOnce();

    controller.destroy();
  });

  it('cancels pending deferred resizes when destroyed before relocation settles', async () => {
    const observer = stubResizeObserver();
    const harness = createQueuedRenditionHarness();
    const target = document.createElement('div');
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 412, 840));
    let currentCfi: string | null = null;

    const controller = new ViewportResizeController(target, harness.rendition, () => currentCfi);

    observer.trigger(412, 915);
    harness.emitStarted();
    harness.setRendered(true);
    controller.destroy();

    currentCfi = 'epubcfi(/6/2!/4/2/1:0)';
    controller.notifyRelocated();
    await Promise.resolve();

    expect(harness.managerResize).not.toHaveBeenCalled();
    expect(harness.runtime.off).toHaveBeenCalledWith('started', expect.any(Function));
  });
});
