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
  it('leaves volume buttons off unless enabled by preference', async () => {
    const nativeActions = actions();
    const features = createReaderNativeFeatures(nativeActions);

    await features.enable(false);
    await features.disable();

    expect(vi.mocked(nativeActions.setVolumeButtons).mock.calls).toEqual([[false], [false]]);
  });

  it('restores native UI after a failed open without blocking a retry', async () => {
    const calls: string[] = [];
    const nativeActions = actions({
      hideStatusBar: async () => void calls.push('hide'),
      showStatusBar: async () => void calls.push('show'),
      setReaderChrome: async (enabled) => void calls.push(`chrome:${enabled}`),
      setVolumeButtons: async (enabled) => void calls.push(`volume:${enabled}`),
      setKeepAwake: async (enabled) => void calls.push(`awake:${enabled}`),
    });
    const features = createReaderNativeFeatures(nativeActions);

    await features.enable(true, true);
    await features.restore();
    await features.enable(false, true);
    await features.disable();

    expect(calls).toEqual([
      'hide',
      'chrome:true',
      'volume:true',
      'awake:true',
      'show',
      'chrome:false',
      'volume:false',
      'awake:false',
      'hide',
      'chrome:true',
      'volume:true',
      'awake:false',
      'show',
      'chrome:false',
      'volume:false',
      'awake:false',
    ]);
  });

  it('applies the saved volume setting on open and updates it while reading', async () => {
    const nativeActions = actions();
    const features = createReaderNativeFeatures(nativeActions);
    await features.enable(false, false);
    await features.setVolumeButtons(true);
    await features.disable();
    await features.setVolumeButtons(true);
    expect(vi.mocked(nativeActions.setVolumeButtons).mock.calls).toEqual([
      [false],
      [true],
      [false],
    ]);
  });

  it('finishes an old reader teardown before enabling a newly opened reader', async () => {
    let releaseOldRequest!: () => void;
    const calls: string[] = [];
    const oldReader = createReaderNativeFeatures(
      actions({
        setKeepAwake: async (enabled) => {
          calls.push(`old:${enabled}`);
          if (enabled) {
            await new Promise<void>((resolve) => (releaseOldRequest = resolve));
          }
        },
      }),
    );
    const newReader = createReaderNativeFeatures(
      actions({
        setKeepAwake: async (enabled) => {
          calls.push(`new:${enabled}`);
        },
      }),
    );
    const oldSetup = oldReader.enable(true);
    await vi.waitFor(() => expect(calls).toEqual(['old:true']));
    const oldTeardown = oldReader.disable();
    const newSetup = newReader.enable(true);
    releaseOldRequest();
    await Promise.all([oldSetup, oldTeardown, newSetup]);

    expect(calls).toEqual(['old:true', 'old:false', 'new:true']);
    await newReader.disable();
  });

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
