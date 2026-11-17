import { registerPlugin } from '@capacitor/core';
import type { ReaderTogglePlugin } from './reader-toggle-plugin';

export const KeepAwake = registerPlugin<ReaderTogglePlugin>('KeepAwake');
