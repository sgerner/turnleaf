import { registerPlugin } from '@capacitor/core';

export interface VolumeButtonsPlugin {
  setEnabled(options: { enabled: boolean }): Promise<void>;
}

export const VolumeButtons = registerPlugin<VolumeButtonsPlugin>('VolumeButtons');
