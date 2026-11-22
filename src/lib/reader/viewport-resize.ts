import type { Rendition } from 'epubjs';

interface ViewportDimensions {
  width: number;
  height: number;
}

interface RenditionManagerLike {
  isRendered?: (() => boolean) | undefined;
  resize?: ((width?: number, height?: number, epubcfi?: string) => unknown) | undefined;
}

interface RenditionQueueLike {
  running?: unknown;
  length?: (() => number) | undefined;
  enqueue?: ((task: () => Promise<void>) => Promise<unknown> | undefined) | undefined;
}

interface RenditionRuntimeLike {
  location?: { start?: { cfi?: string | undefined } | undefined } | undefined;
  manager?: RenditionManagerLike | undefined;
  on?: ((event: string, listener: () => void) => void) | undefined;
  off?: ((event: string, listener: () => void) => void) | undefined;
  q?: RenditionQueueLike | undefined;
  resize: (width: number, height: number, epubcfi?: string) => void;
}

const RELOCATION_SETTLE_FALLBACK_MS = 500;

/**
 * Coordinates viewport size changes with EPUB.js rendition startup, queued
 * display operations, and requestAnimationFrame-deferred location reporting so
 * system-bar transitions do not clear views or revert navigation mid-render.
 */
export class ViewportResizeController {
  private readonly runtime: RenditionRuntimeLike;
  private readonly handleStarted = () => {
    this.installManagerGuard();
  };
  private resizeObserver: ResizeObserver | null = null;
  private viewportSize: ViewportDimensions;
  private pendingSize: ViewportDimensions | null = null;
  private activeOperations = 0;
  private relocationEpoch = 0;
  private operationStartRelocationEpoch = 0;
  private awaitingRelocation = false;
  private relocationFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private flushScheduled = false;
  private applyingResize = false;
  private managerGuarded = false;
  private destroyed = false;

  constructor(
    private readonly target: HTMLElement,
    private readonly rendition: Rendition,
    private readonly getCurrentCfi: () => string | null,
  ) {
    this.runtime = rendition as unknown as RenditionRuntimeLike;
    const initial = target.getBoundingClientRect();
    this.viewportSize = {
      width: Math.floor(initial.width),
      height: Math.floor(initial.height),
    };

    this.runtime.on?.('started', this.handleStarted);
    this.installManagerGuard();

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry || this.destroyed) return;
        const width = Math.floor(entry.contentRect.width);
        const height = Math.floor(entry.contentRect.height);
        if (!width || !height) return;
        this.requestResize(width, height);
      });
      this.resizeObserver.observe(target);
    }
  }

  async trackOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.activeOperations === 0) {
      this.operationStartRelocationEpoch = this.relocationEpoch;
    }
    this.activeOperations += 1;
    let succeeded = false;
    try {
      const result = await operation();
      succeeded = true;
      return result;
    } finally {
      this.activeOperations = Math.max(0, this.activeOperations - 1);
      this.installManagerGuard();
      if (this.activeOperations === 0 && !this.destroyed) {
        if (
          succeeded &&
          typeof this.runtime.q?.enqueue === 'function' &&
          this.relocationEpoch === this.operationStartRelocationEpoch
        ) {
          this.awaitRelocation();
        } else {
          this.scheduleFlush();
        }
      }
    }
  }

  awaitRelocation(): void {
    if (this.destroyed || typeof this.runtime.q?.enqueue !== 'function') return;
    this.awaitingRelocation = true;
    this.clearRelocationFallback();
    this.relocationFallbackTimer = setTimeout(() => {
      this.relocationFallbackTimer = null;
      if (this.destroyed || !this.awaitingRelocation) return;
      this.awaitingRelocation = false;
      this.scheduleFlush();
    }, RELOCATION_SETTLE_FALLBACK_MS);
  }

  notifyRelocated(): void {
    if (this.destroyed) return;
    this.relocationEpoch += 1;
    this.awaitingRelocation = false;
    this.clearRelocationFallback();
    this.installManagerGuard();
    this.scheduleFlush();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearRelocationFallback();
    this.runtime.off?.('started', this.handleStarted);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.pendingSize = null;
    this.activeOperations = 0;
    this.awaitingRelocation = false;
    this.flushScheduled = false;
    this.applyingResize = false;
  }

  private clearRelocationFallback(): void {
    if (this.relocationFallbackTimer !== null) {
      clearTimeout(this.relocationFallbackTimer);
      this.relocationFallbackTimer = null;
    }
  }

  private installManagerGuard(): void {
    if (this.destroyed || this.managerGuarded) return;
    const manager = this.runtime.manager;
    if (!manager || typeof manager.resize !== 'function') return;
    this.managerGuarded = true;
    const originalResize = manager.resize.bind(manager);
    manager.resize = (width?: number, height?: number, epubcfi?: string) => {
      if (this.destroyed) return undefined;
      if (this.applyingResize) {
        return originalResize(width, height, epubcfi);
      }
      const measured = this.measureTarget(width, height);
      if (!measured) return undefined;
      if (this.canResizeNow()) {
        if (
          this.viewportSize.width === measured.width &&
          this.viewportSize.height === measured.height &&
          !epubcfi
        ) {
          return undefined;
        }
        this.pendingSize = null;
        this.viewportSize = measured;
        return originalResize(measured.width, measured.height, epubcfi);
      }
      this.pendingSize = measured;
      this.scheduleFlush();
      return undefined;
    };
  }

  private measureTarget(width?: number, height?: number): ViewportDimensions | null {
    if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
      return { width: Math.floor(width), height: Math.floor(height) };
    }
    const rect = this.target.getBoundingClientRect();
    const measuredWidth = Math.floor(rect.width);
    const measuredHeight = Math.floor(rect.height);
    if (!measuredWidth || !measuredHeight) return null;
    return { width: measuredWidth, height: measuredHeight };
  }

  private requestResize(width: number, height: number): void {
    if (this.destroyed) return;
    this.installManagerGuard();
    if (this.viewportSize.width === width && this.viewportSize.height === height) {
      this.pendingSize = null;
      return;
    }
    if (this.canResizeNow()) {
      this.pendingSize = null;
      this.performResize(width, height);
      return;
    }
    this.pendingSize = { width, height };
    this.scheduleFlush();
  }

  private canResizeNow(ignoreQueueRunning = false): boolean {
    if (this.destroyed || this.activeOperations > 0 || this.awaitingRelocation) return false;
    const queuedRendition = typeof this.runtime.q?.enqueue === 'function';
    if (!ignoreQueueRunning && this.runtime.q?.running) return false;
    if (typeof this.runtime.q?.length === 'function' && this.runtime.q.length() > 0) {
      return false;
    }
    if (queuedRendition || this.runtime.manager !== undefined) {
      if (!this.runtime.manager) return false;
      if (
        typeof this.runtime.manager.isRendered === 'function' &&
        !this.runtime.manager.isRendered()
      ) {
        return false;
      }
      if (!this.getCurrentCfi() && !this.runtime.location?.start?.cfi) {
        return false;
      }
    }
    return true;
  }

  private performResize(width: number, height: number): void {
    if (this.destroyed) return;
    this.viewportSize = { width, height };
    const fallbackCfi = !this.runtime.location?.start?.cfi
      ? (this.getCurrentCfi() ?? undefined)
      : undefined;
    this.applyingResize = true;
    try {
      if (fallbackCfi) {
        this.runtime.resize(width, height, fallbackCfi);
      } else {
        this.rendition.resize(width, height);
      }
    } finally {
      this.applyingResize = false;
    }
  }

  private scheduleFlush(): void {
    if (this.destroyed || !this.pendingSize || this.activeOperations > 0 || this.awaitingRelocation)
      return;
    if (typeof this.runtime.q?.enqueue !== 'function') {
      if (this.canResizeNow()) {
        const next = this.pendingSize;
        this.pendingSize = null;
        if (this.viewportSize.width !== next.width || this.viewportSize.height !== next.height) {
          this.performResize(next.width, next.height);
        }
      }
      return;
    }
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    void this.runtime.q
      .enqueue(
        () =>
          new Promise<void>((resolve) => {
            const afterFrame =
              typeof requestAnimationFrame === 'function'
                ? requestAnimationFrame
                : (callback: () => void) => setTimeout(callback, 0);
            afterFrame(() => resolve());
          }),
      )
      ?.then(() => {
        this.flushScheduled = false;
        if (
          this.destroyed ||
          !this.pendingSize ||
          this.activeOperations > 0 ||
          this.awaitingRelocation
        ) {
          return;
        }
        if (typeof this.runtime.q?.length === 'function' && this.runtime.q.length() > 0) {
          this.scheduleFlush();
          return;
        }
        if (!this.canResizeNow(true)) return;
        const next = this.pendingSize;
        this.pendingSize = null;
        if (this.viewportSize.width === next.width && this.viewportSize.height === next.height) {
          return;
        }
        this.performResize(next.width, next.height);
      })
      .catch(() => {
        this.flushScheduled = false;
      });
  }
}
