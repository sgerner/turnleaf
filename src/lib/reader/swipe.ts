export type ReaderSwipeDirection = 'previous' | 'next';

export interface SwipeTouchPoint {
  identifier?: number;
  clientX: number;
  clientY: number;
}

export interface SwipeTouchEventLike {
  target?: EventTarget | null;
  touches?: ArrayLike<SwipeTouchPoint>;
  changedTouches?: ArrayLike<SwipeTouchPoint>;
  defaultPrevented?: boolean;
}

export interface SwipePointerEventLike {
  pointerId: number;
  pointerType?: string;
  button?: number;
  clientX: number;
  clientY: number;
  target?: EventTarget | null;
  defaultPrevented?: boolean;
}

export const SWIPE_MIN_DISTANCE_PX = 44;
export const SWIPE_MAX_DRIFT_RATIO = 0.5;
const SWIPE_CLICK_SUPPRESSION_MS = 500;
const INTERACTIVE_SWIPE_SELECTOR =
  'a, button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="slider"], [contenteditable="true"]';

type ActiveGesture = {
  id: number | undefined;
  x: number;
  y: number;
  lastX: number;
  lastY: number;
  maxDriftY: number;
  blocked: boolean;
};

function isBlockedStart(
  event: { defaultPrevented?: boolean; target?: EventTarget | null },
  hasSelection?: () => boolean,
): boolean {
  const el =
    event.target && typeof (event.target as Element).closest === 'function'
      ? (event.target as Element)
      : null;
  return (
    Boolean(event.defaultPrevented) ||
    Boolean(el?.closest(INTERACTIVE_SWIPE_SELECTOR)) ||
    Boolean(hasSelection?.())
  );
}

function resolveDirection(
  gesture: ActiveGesture,
  endX: number,
  endY: number,
): ReaderSwipeDirection | null {
  const deltaX = endX - gesture.x;
  const absX = Math.abs(deltaX);
  const absY = Math.max(Math.abs(endY - gesture.y), gesture.maxDriftY);
  if (absX < SWIPE_MIN_DISTANCE_PX || absY > absX * SWIPE_MAX_DRIFT_RATIO) return null;
  return deltaX < 0 ? 'next' : 'previous';
}

function findTouch(
  list: ArrayLike<SwipeTouchPoint> | undefined,
  id: number | undefined,
): SwipeTouchPoint | null {
  if (!list || list.length === 0) return null;
  if (id !== undefined) {
    for (let index = 0; index < list.length; index += 1) {
      if (list[index]?.identifier === id) return list[index] ?? null;
    }
  }
  return list[0] ?? null;
}

export interface SwipeGestureTracker {
  onTouchStart: (event: SwipeTouchEventLike, hasSelection?: () => boolean) => void;
  onTouchMove: (event: SwipeTouchEventLike, hasSelection?: () => boolean) => void;
  onTouchEnd: (event: SwipeTouchEventLike, hasSelection?: () => boolean) => void;
  onTouchCancel: () => void;
  onPointerDown: (event: SwipePointerEventLike, hasSelection?: () => boolean) => void;
  onPointerMove: (event: SwipePointerEventLike, hasSelection?: () => boolean) => void;
  onPointerUp: (event: SwipePointerEventLike, hasSelection?: () => boolean) => void;
  onPointerCancel: (event: SwipePointerEventLike) => void;
  consumeSuppressedClick: () => boolean;
  reset: () => void;
}

export function createSwipeGestureTracker(
  onSwipe: (direction: ReaderSwipeDirection) => void,
  now: () => number = () => Date.now(),
): SwipeGestureTracker {
  let touchStart: ActiveGesture | null = null;
  let pointerStart: ActiveGesture | null = null;
  let touchCompletedAt = -Infinity;
  let suppressClickUntil = 0;
  const activeTouchPointers = new Set<number>();

  const makeGesture = (
    id: number | undefined,
    x: number,
    y: number,
    blocked: boolean,
  ): ActiveGesture => ({ id, x, y, lastX: x, lastY: y, maxDriftY: 0, blocked });

  const moveGesture = (gesture: ActiveGesture, x: number, y: number): void => {
    gesture.lastX = x;
    gesture.lastY = y;
    gesture.maxDriftY = Math.max(gesture.maxDriftY, Math.abs(y - gesture.y));
  };

  return {
    onTouchStart(event, hasSelection) {
      suppressClickUntil = 0;
      activeTouchPointers.clear();
      pointerStart = null;
      if ((event.touches?.length ?? 1) !== 1) {
        touchStart = touchStart
          ? { ...touchStart, blocked: true }
          : makeGesture(undefined, 0, 0, true);
        return;
      }
      const first = event.touches?.[0] ?? event.changedTouches?.[0];
      if (!first) return;
      touchStart = makeGesture(
        first.identifier,
        first.clientX,
        first.clientY,
        isBlockedStart(event, hasSelection),
      );
    },
    onTouchMove(event, hasSelection) {
      if (!touchStart) return;
      if ((event.touches?.length ?? 1) > 1 || hasSelection?.()) {
        touchStart.blocked = true;
        return;
      }
      const point = findTouch(event.touches ?? event.changedTouches, touchStart.id);
      if (point) moveGesture(touchStart, point.clientX, point.clientY);
    },
    onTouchEnd(event, hasSelection) {
      touchCompletedAt = now();
      if (!touchStart) return;
      const remaining = event.touches?.length ?? 0;
      if (touchStart.blocked || hasSelection?.() || remaining > 0) {
        touchStart = remaining > 0 ? { ...touchStart, blocked: true } : null;
        return;
      }
      const endPoint = findTouch(event.changedTouches, touchStart.id);
      const gesture = touchStart;
      touchStart = null;
      const direction = resolveDirection(
        gesture,
        endPoint?.clientX ?? gesture.lastX,
        endPoint?.clientY ?? gesture.lastY,
      );
      if (!direction) return;
      suppressClickUntil = touchCompletedAt + SWIPE_CLICK_SUPPRESSION_MS;
      onSwipe(direction);
    },
    onTouchCancel() {
      touchStart = null;
    },
    onPointerDown(event, hasSelection) {
      if (event.pointerType !== 'touch' || touchStart !== null || now() - touchCompletedAt < 100) {
        return;
      }
      suppressClickUntil = 0;
      activeTouchPointers.add(event.pointerId);
      if (activeTouchPointers.size !== 1) {
        if (pointerStart) pointerStart.blocked = true;
        return;
      }
      pointerStart = makeGesture(
        event.pointerId,
        event.clientX,
        event.clientY,
        isBlockedStart(event, hasSelection),
      );
    },
    onPointerMove(event, hasSelection) {
      if (event.pointerType !== 'touch' || !pointerStart || touchStart !== null) return;
      if (activeTouchPointers.size > 1 || hasSelection?.()) {
        pointerStart.blocked = true;
        return;
      }
      if (event.pointerId === pointerStart.id)
        moveGesture(pointerStart, event.clientX, event.clientY);
    },
    onPointerUp(event, hasSelection) {
      if (event.pointerType !== 'touch') return;
      activeTouchPointers.delete(event.pointerId);
      if (!pointerStart || touchStart !== null || now() - touchCompletedAt < 100) {
        if (activeTouchPointers.size === 0) pointerStart = null;
        return;
      }
      if (pointerStart.blocked || hasSelection?.() || activeTouchPointers.size > 0) {
        pointerStart = activeTouchPointers.size > 0 ? { ...pointerStart, blocked: true } : null;
        return;
      }
      if (event.pointerId !== pointerStart.id) return;
      const gesture = pointerStart;
      pointerStart = null;
      const direction = resolveDirection(gesture, event.clientX, event.clientY);
      if (!direction) return;
      suppressClickUntil = now() + SWIPE_CLICK_SUPPRESSION_MS;
      onSwipe(direction);
    },
    onPointerCancel(event) {
      activeTouchPointers.delete(event.pointerId);
      pointerStart =
        activeTouchPointers.size === 0
          ? null
          : pointerStart
            ? { ...pointerStart, blocked: true }
            : null;
    },
    consumeSuppressedClick() {
      const suppressed = suppressClickUntil > 0 && now() <= suppressClickUntil;
      suppressClickUntil = 0;
      return suppressed;
    },
    reset() {
      touchStart = null;
      pointerStart = null;
      activeTouchPointers.clear();
      suppressClickUntil = 0;
    },
  };
}

export function attachSwipeGestureListeners(
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  tracker: SwipeGestureTracker,
  hasSelection?: () => boolean,
  options?: { touchEvents?: boolean; suppressClick?: boolean },
): () => void {
  const cleanups: Array<() => void> = [];
  const listen = (type: string, handler: EventListener, capture = false) => {
    target.addEventListener(type, handler, capture ? true : { passive: true });
    cleanups.push(() => target.removeEventListener?.(type, handler, capture));
  };
  if (options?.touchEvents ?? true) {
    listen('touchstart', (e) =>
      tracker.onTouchStart(e as unknown as SwipeTouchEventLike, hasSelection),
    );
    listen('touchmove', (e) =>
      tracker.onTouchMove(e as unknown as SwipeTouchEventLike, hasSelection),
    );
    listen('touchend', (e) =>
      tracker.onTouchEnd(e as unknown as SwipeTouchEventLike, hasSelection),
    );
  }
  listen('touchcancel', () => tracker.onTouchCancel());
  listen('pointerdown', (e) =>
    tracker.onPointerDown(e as unknown as SwipePointerEventLike, hasSelection),
  );
  listen('pointermove', (e) =>
    tracker.onPointerMove(e as unknown as SwipePointerEventLike, hasSelection),
  );
  listen('pointerup', (e) =>
    tracker.onPointerUp(e as unknown as SwipePointerEventLike, hasSelection),
  );
  listen('pointercancel', (e) => tracker.onPointerCancel(e as unknown as SwipePointerEventLike));
  if (options?.suppressClick ?? true) {
    listen(
      'click',
      (event) => {
        if (!tracker.consumeSuppressedClick()) return;
        event.preventDefault();
        event.stopPropagation();
      },
      true,
    );
  }
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
