import { registerPlugin } from '@capacitor/core';

export interface ReaderChromePlugin {
  setEnabled(options: { enabled: boolean }): Promise<void>;
}

export const ReaderChrome = registerPlugin<ReaderChromePlugin>('ReaderChrome');
