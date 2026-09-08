export interface ReaderNativeFeatureActions {
  hideStatusBar: () => Promise<void>;
  showStatusBar: () => Promise<void>;
  setReaderChrome: (enabled: boolean) => Promise<void>;
  setVolumeButtons: (enabled: boolean) => Promise<void>;
  setKeepAwake: (enabled: boolean) => Promise<void>;
}

export interface ReaderNativeFeatures {
  enable: (keepAwake: boolean) => Promise<void>;
  setKeepAwake: (enabled: boolean) => Promise<void>;
  disable: () => Promise<void>;
}

// Native controls belong to the app window, so an old reader's teardown must
// finish before a newly opened reader enables them.
let queue = Promise.resolve();

export function createReaderNativeFeatures(
  actions: ReaderNativeFeatureActions,
): ReaderNativeFeatures {
  let active = true;

  function enqueue(operation: () => Promise<void>): Promise<void> {
    const next = queue.then(operation, operation);
    queue = next.catch(() => undefined);
    return next;
  }

  async function attempt(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch {
      // Native reader helpers are optional and must not prevent reading.
    }
  }

  function enable(keepAwake: boolean): Promise<void> {
    return enqueue(async () => {
      if (!active) return;

      await attempt(actions.hideStatusBar);
      if (!active) return;
      await attempt(() => actions.setReaderChrome(true));
      if (!active) return;
      await attempt(() => actions.setVolumeButtons(true));
      if (!active) return;
      await attempt(() => actions.setKeepAwake(keepAwake));
    });
  }

  function setKeepAwake(enabled: boolean): Promise<void> {
    return enqueue(async () => {
      if (!active) return;
      await attempt(() => actions.setKeepAwake(enabled));
    });
  }

  function disable(): Promise<void> {
    if (!active) return queue;
    active = false;
    return enqueue(async () => {
      await attempt(actions.showStatusBar);
      await attempt(() => actions.setReaderChrome(false));
      await attempt(() => actions.setVolumeButtons(false));
      await attempt(() => actions.setKeepAwake(false));
    });
  }

  return { enable, setKeepAwake, disable };
}
