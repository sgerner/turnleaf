import { registerPlugin } from '@capacitor/core';
import type { ReaderTogglePlugin } from './reader-toggle-plugin';

export type VolumeButtonDirection = 'next' | 'previous';

type VolumeButtonWindowEvent = Event & {
  direction?: unknown;
  detail?: { direction?: unknown } | null | undefined;
};

export const VolumeButtons = registerPlugin<ReaderTogglePlugin>('VolumeButtons');

export function parseVolumeButtonDirection(event: Event): VolumeButtonDirection | null {
  const candidate = event as VolumeButtonWindowEvent;
  const direction = candidate.direction ?? candidate.detail?.direction;
  return direction === 'next' || direction === 'previous' ? direction : null;
}
