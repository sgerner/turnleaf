import { registerPlugin } from '@capacitor/core';

export interface KeepAwakePlugin {
  setEnabled(options: { enabled: boolean }): Promise<void>;
}

export const KeepAwake = registerPlugin<KeepAwakePlugin>('KeepAwake');
