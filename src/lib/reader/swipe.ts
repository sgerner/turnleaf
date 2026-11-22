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

function isInteractiveSwipeTarget(target: EventTarget | null | undefined): boolean {
  const element =
    target && typeof (target as Element).closest === 'function' ? (target as Element) : null;
  return Boolean(element?.closest(INTERACTIVE_SWIPE_SELECTOR));
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
  let touchStart: {
    id: number | undefined;
    x: number;
    y: number;
    lastX: number;
    lastY: number;
    maxDriftY: number;
    blocked: boolean;
  } | null = null;
  let touchCompletedAt = -Infinity;
  const activeTouchPointers = new Set<number>();
  let pointerStart: {
    id: number;
    x: number;
    y: number;
    lastX: number;
    lastY: number;
    maxDriftY: number;
    blocked: boolean;
  } | null = null;
  let suppressClickUntil = 0;

  function evaluateSwipe(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    maxDriftY: number,
  ): ReaderSwipeDirection | null {
    const deltaX = endX - startX;
    const absX = Math.abs(deltaX);
    const absY = Math.max(Math.abs(endY - startY), maxDriftY);
    if (absX < SWIPE_MIN_DISTANCE_PX) return null;
    if (absY > absX * SWIPE_MAX_DRIFT_RATIO) return null;
    return deltaX < 0 ? 'next' : 'previous';
  }

  function findTouch(
    list: ArrayLike<SwipeTouchPoint> | undefined,
    id: number | undefined,
  ): SwipeTouchPoint | null {
    if (!list || list.length === 0) return null;
    if (id === undefined) return list[0] ?? null;
    for (let index = 0; index < list.length; index += 1) {
      const item = list[index];
      if (item && item.identifier === id) return item;
    }
    return list[0] ?? null;
  }

  return {
    onTouchStart(event, hasSelection) {
      suppressClickUntil = 0;
      activeTouchPointers.clear();
      pointerStart = null;
      const touches = event.touches;
      const touchCount = touches?.length ?? 1;
      if (touchCount !== 1) {
        if (touchStart) touchStart.blocked = true;
        else {
          touchStart = {
            id: undefined,
            x: 0,
            y: 0,
            lastX: 0,
            lastY: 0,
            maxDriftY: 0,
            blocked: true,
          };
        }
        return;
      }
      const first = touches?.[0] ?? event.changedTouches?.[0];
      if (!first) return;
      const blocked =
        Boolean(event.defaultPrevented) ||
        isInteractiveSwipeTarget(event.target) ||
        Boolean(hasSelection?.());
      touchStart = {
        id: first.identifier,
        x: first.clientX,
        y: first.clientY,
        lastX: first.clientX,
        lastY: first.clientY,
        maxDriftY: 0,
        blocked,
      };
    },

    onTouchMove(event, hasSelection) {
      if (!touchStart) return;
      if ((event.touches?.length ?? 1) > 1 || hasSelection?.()) {
        touchStart.blocked = true;
        return;
      }
      const point = findTouch(event.touches ?? event.changedTouches, touchStart.id);
      if (!point) return;
      touchStart.lastX = point.clientX;
      touchStart.lastY = point.clientY;
      touchStart.maxDriftY = Math.max(touchStart.maxDriftY, Math.abs(point.clientY - touchStart.y));
    },

    onTouchEnd(event, hasSelection) {
      touchCompletedAt = now();
      if (!touchStart) return;
      const remaining = event.touches?.length ?? 0;
      if (touchStart.blocked || hasSelection?.()) {
        if (remaining === 0) touchStart = null;
        return;
      }
      if (remaining > 0) {
        touchStart.blocked = true;
        return;
      }
      const endPoint = findTouch(event.changedTouches, touchStart.id) ?? {
        clientX: touchStart.lastX,
        clientY: touchStart.lastY,
      };
      const gesture = touchStart;
      touchStart = null;
      const direction = evaluateSwipe(
        gesture.x,
        gesture.y,
        endPoint.clientX,
        endPoint.clientY,
        gesture.maxDriftY,
      );
      if (!direction) return;
      suppressClickUntil = touchCompletedAt + SWIPE_CLICK_SUPPRESSION_MS;
      onSwipe(direction);
    },

    onTouchCancel() {
      touchStart = null;
    },

    onPointerDown(event, hasSelection) {
      if (event.pointerType !== 'touch') return;
      if (touchStart !== null || now() - touchCompletedAt < 100) return;
      suppressClickUntil = 0;
      activeTouchPointers.add(event.pointerId);
      if (activeTouchPointers.size !== 1) {
        if (pointerStart) pointerStart.blocked = true;
        return;
      }
      const blocked =
        Boolean(event.defaultPrevented) ||
        isInteractiveSwipeTarget(event.target) ||
        Boolean(hasSelection?.());
      pointerStart = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        maxDriftY: 0,
        blocked,
      };
    },

    onPointerMove(event, hasSelection) {
      if (event.pointerType !== 'touch' || !pointerStart || touchStart !== null) return;
      if (activeTouchPointers.size > 1 || hasSelection?.()) {
        pointerStart.blocked = true;
        return;
      }
      if (event.pointerId !== pointerStart.id) return;
      pointerStart.lastX = event.clientX;
      pointerStart.lastY = event.clientY;
      pointerStart.maxDriftY = Math.max(
        pointerStart.maxDriftY,
        Math.abs(event.clientY - pointerStart.y),
      );
    },

    onPointerUp(event, hasSelection) {
      if (event.pointerType !== 'touch') return;
      activeTouchPointers.delete(event.pointerId);
      if (!pointerStart || touchStart !== null || now() - touchCompletedAt < 100) {
        if (activeTouchPointers.size === 0) pointerStart = null;
        return;
      }
      if (pointerStart.blocked || hasSelection?.() || activeTouchPointers.size > 0) {
        if (activeTouchPointers.size > 0) pointerStart.blocked = true;
        else pointerStart = null;
        return;
      }
      if (event.pointerId !== pointerStart.id) return;
      const gesture = pointerStart;
      pointerStart = null;
      const direction = evaluateSwipe(
        gesture.x,
        gesture.y,
        event.clientX,
        event.clientY,
        gesture.maxDriftY,
      );
      if (!direction) return;
      suppressClickUntil = now() + SWIPE_CLICK_SUPPRESSION_MS;
      onSwipe(direction);
    },

    onPointerCancel(event) {
      activeTouchPointers.delete(event.pointerId);
      if (activeTouchPointers.size === 0) pointerStart = null;
      else if (pointerStart) pointerStart.blocked = true;
    },

    consumeSuppressedClick() {
      if (suppressClickUntil > 0 && now() <= suppressClickUntil) {
        suppressClickUntil = 0;
        return true;
      }
      suppressClickUntil = 0;
      return false;
    },

    reset() {
      touchStart = null;
      pointerStart = null;
      activeTouchPointers.clear();
      suppressClickUntil = 0;
    },
  };
}
