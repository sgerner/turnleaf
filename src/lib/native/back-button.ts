export type BackButtonHandler = () => boolean;

export type RegisterBackHandler = (handler: BackButtonHandler) => () => void;

export interface BackButtonStack {
  register: RegisterBackHandler;
  dispatch: () => boolean;
}

export function createBackButtonStack(
  options: {
    exitApp?: (() => void) | undefined;
  } = {},
): BackButtonStack {
  const entries: Array<{ handler: BackButtonHandler }> = [];

  function register(handler: BackButtonHandler): () => void {
    const entry = { handler };
    entries.push(entry);
    return () => {
      const index = entries.indexOf(entry);
      if (index >= 0) entries.splice(index, 1);
    };
  }

  function dispatch(): boolean {
    const snapshot = [...entries];
    for (let index = snapshot.length - 1; index >= 0; index -= 1) {
      if (snapshot[index]!.handler()) return true;
    }
    options.exitApp?.();
    return false;
  }

  return { register, dispatch };
}

export function handleOnboardingBack(options: {
  busy: boolean;
  onCancel?: (() => void) | undefined;
}): boolean {
  if (options.busy) return true;
  if (!options.onCancel) return false;
  options.onCancel();
  return true;
}

export interface LibraryBackState {
  hasConflict: boolean;
  acceptingRemoteProgress: boolean;
  hasActionMenu: boolean;
  hasOpenReader: boolean;
  settingsVisible: boolean;
  filtersVisible: boolean;
}

export interface LibraryBackActions {
  closeConflict: () => void;
  closeMenu: () => void;
  closeReader: () => void;
  closeSettings: () => void;
  hideFilters: () => void;
}

export function handleLibraryBack(state: LibraryBackState, actions: LibraryBackActions): boolean {
  if (state.hasConflict) {
    if (!state.acceptingRemoteProgress) actions.closeConflict();
    return true;
  }
  if (state.hasActionMenu) {
    actions.closeMenu();
    return true;
  }
  if (state.hasOpenReader) {
    actions.closeReader();
    return true;
  }
  if (state.settingsVisible) {
    actions.closeSettings();
    return true;
  }
  if (state.filtersVisible) {
    actions.hideFilters();
    return true;
  }
  return false;
}
