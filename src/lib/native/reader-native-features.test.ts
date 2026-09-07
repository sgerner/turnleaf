import { describe, expect, it, vi } from 'vitest';
import {
  createReaderNativeFeatures,
  type ReaderNativeFeatureActions,
} from './reader-native-features';

function actions(overrides: Partial<ReaderNativeFeatureActions> = {}): ReaderNativeFeatureActions {
  return {
    hideStatusBar: vi.fn(async () => undefined),
    showStatusBar: vi.fn(async () => undefined),
    setReaderChrome: vi.fn(async () => undefined),
    setVolumeButtons: vi.fn(async () => undefined),
    setKeepAwake: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('reader native features', () => {
  it('queues teardown after an in-flight enable and skips stale setup', async () => {
    let releaseHide!: () => void;
    const hideStatusBar = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseHide = resolve;
        }),
    );
    const nativeActions = actions({ hideStatusBar });
    const features = createReaderNativeFeatures(nativeActions);

    const enabling = features.enable(true);
    await Promise.resolve();
    const disabling = features.disable();
    releaseHide();

    await Promise.all([enabling, disabling]);

    expect(nativeActions.hideStatusBar).toHaveBeenCalledOnce();
    expect(nativeActions.showStatusBar).toHaveBeenCalledOnce();
    expect(nativeActions.setReaderChrome).toHaveBeenCalledWith(false);
    expect(nativeActions.setVolumeButtons).toHaveBeenCalledWith(false);
    expect(nativeActions.setKeepAwake).toHaveBeenCalledWith(false);
    expect(nativeActions.setReaderChrome).not.toHaveBeenCalledWith(true);
    expect(nativeActions.setVolumeButtons).not.toHaveBeenCalledWith(true);
    expect(nativeActions.setKeepAwake).not.toHaveBeenCalledWith(true);
  });

  it('ignores preference changes after teardown', async () => {
    const nativeActions = actions();
    const features = createReaderNativeFeatures(nativeActions);

    await features.disable();
    await features.setKeepAwake(true);

    expect(nativeActions.setKeepAwake).toHaveBeenCalledWith(false);
    expect(nativeActions.setKeepAwake).not.toHaveBeenCalledWith(true);
  });

  it('applies teardown after a pending keep-awake request resolves', async () => {
    let releaseKeepAwake!: () => void;
    const setKeepAwake = vi.fn((enabled: boolean) =>
      enabled
        ? new Promise<void>((resolve) => {
            releaseKeepAwake = resolve;
          })
        : Promise.resolve(),
    );
    const nativeActions = actions({ setKeepAwake });
    const features = createReaderNativeFeatures(nativeActions);

    const enabling = features.enable(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(setKeepAwake).toHaveBeenCalledWith(true);

    const disabling = features.disable();
    releaseKeepAwake();
    await Promise.all([enabling, disabling]);

    expect(setKeepAwake.mock.calls.map(([enabled]) => enabled)).toEqual([true, false]);
  });
});
