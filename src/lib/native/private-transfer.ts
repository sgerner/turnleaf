import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export const PRIVATE_TRANSFER_CONNECTION_FAILED = 'PRIVATE_TRANSFER_CONNECTION_FAILED';

export interface PrivateDownloadOptions {
  url: string;
  relativePath: string;
  headers?: Record<string, string>;
  connectTimeout?: number;
  readTimeout?: number;
  progress?: boolean;
  transferId?: string;
}

export interface PrivateDownloadResult {
  status: number;
  location?: string | null;
  bytesWritten?: number;
}

export interface PrivateDownloadProgressEvent {
  transferId?: string;
  url: string;
  bytes: number;
  contentLength: number;
  lengthComputable: boolean;
}

export interface PrivateTransferPlugin {
  downloadFile(options: PrivateDownloadOptions): Promise<PrivateDownloadResult>;
  addListener(
    eventName: 'progress',
    listenerFunc: (event: PrivateDownloadProgressEvent) => void,
  ): Promise<PluginListenerHandle>;
}

let registeredPrivateTransfer: PrivateTransferPlugin | null = null;

function getPrivateTransfer(): PrivateTransferPlugin {
  if (!registeredPrivateTransfer) {
    registeredPrivateTransfer = registerPlugin<PrivateTransferPlugin>('PrivateTransfer');
  }
  return registeredPrivateTransfer;
}

export const PrivateTransfer: PrivateTransferPlugin = {
  get downloadFile() {
    return getPrivateTransfer().downloadFile;
  },
  get addListener() {
    return getPrivateTransfer().addListener;
  },
};
