import { registerPlugin } from '@capacitor/core';
import type { ReaderTogglePlugin } from './reader-toggle-plugin';

export const VolumeButtons = registerPlugin<ReaderTogglePlugin>('VolumeButtons');
