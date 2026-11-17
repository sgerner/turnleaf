import { registerPlugin } from '@capacitor/core';
import type { ReaderTogglePlugin } from './reader-toggle-plugin';

export const ReaderChrome = registerPlugin<ReaderTogglePlugin>('ReaderChrome');
