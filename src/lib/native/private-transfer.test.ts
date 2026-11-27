import { beforeEach, describe, expect, it, vi } from 'vitest';

const { registerPluginSpy, downloadFileMock, abortTransferMock, addListenerMock } = vi.hoisted(
  () => ({
    registerPluginSpy: vi.fn(),
    downloadFileMock: vi.fn(),
    abortTransferMock: vi.fn(),
    addListenerMock: vi.fn(),
  }),
);

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
  },
  get registerPlugin() {
    return registerPluginSpy;
  },
}));

describe('PrivateTransfer lazy plugin registration', () => {
  beforeEach(() => {
    vi.resetModules();
    registerPluginSpy.mockReset();
    downloadFileMock.mockReset();
    abortTransferMock.mockReset();
    addListenerMock.mockReset();
    registerPluginSpy.mockReturnValue({
      downloadFile: downloadFileMock,
      abortTransfer: abortTransferMock,
      addListener: addListenerMock,
    });
  });

  it('defers registerPlugin until first method access and caches the plugin instance', async () => {
    const { PrivateTransfer } = await import('./private-transfer');
    expect(registerPluginSpy).not.toHaveBeenCalled();

    downloadFileMock.mockResolvedValueOnce({ status: 200, bytesWritten: 42 });
    const result = await PrivateTransfer.downloadFile({
      url: 'https://kavita.example/api/Download/chapter',
      relativePath: 'books/test.epub.partial',
    });

    expect(result).toEqual({ status: 200, bytesWritten: 42 });
    expect(registerPluginSpy).toHaveBeenCalledExactlyOnceWith('PrivateTransfer');

    abortTransferMock.mockResolvedValueOnce(undefined);
    await PrivateTransfer.abortTransfer({ transferId: 'epub-1' });
    addListenerMock.mockResolvedValueOnce({ remove: async () => undefined });
    await PrivateTransfer.addListener('progress', () => undefined);
    expect(registerPluginSpy).toHaveBeenCalledTimes(1);
  });
});
