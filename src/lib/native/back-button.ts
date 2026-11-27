export type BackButtonHandler = () => boolean;

export type RegisterBackHandler = (handler: BackButtonHandler) => () => void;

export interface BackButtonStack {
  register: RegisterBackHandler;
  dispatch: () => boolean;
  clear: () => void;
}

export function createBackButtonStack(
  options: {
    exitApp?: (() => void) | undefined;
  } = {},
): BackButtonStack {
  const entries: Array<{ handler: BackButtonHandler; active: boolean }> = [];

  return {
    register(handler: BackButtonHandler): () => void {
      const entry = { handler, active: true };
      entries.push(entry);
      return () => {
        if (!entry.active) return;
        entry.active = false;
        const index = entries.indexOf(entry);
        if (index >= 0) entries.splice(index, 1);
      };
    },
    dispatch(): boolean {
      const snapshot = [...entries];
      for (let index = snapshot.length - 1; index >= 0; index -= 1) {
        const entry = snapshot[index];
        if (entry?.active && entry.handler()) return true;
      }
      options.exitApp?.();
      return false;
    },
    clear(): void {
      for (const entry of entries) entry.active = false;
      entries.length = 0;
    },
  };
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
  resolvingOpenProgress?: boolean;
  editingServerAddress?: boolean;
  savingServerAddress?: boolean;
  confirmDeleteServer?: boolean;
  settingsBusy?: boolean;
  settingsVisible: boolean;
  filtersVisible: boolean;
}

export interface LibraryBackActions {
  closeConflict: () => void;
  closeMenu: () => void;
  closeReader: () => void;
  cancelOpenProgress?: () => void;
  cancelServerAddressEdit?: () => void;
  cancelDeleteServer?: () => void;
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
  if (state.resolvingOpenProgress) {
    actions.cancelOpenProgress?.();
    return true;
  }
  if (state.settingsVisible && state.editingServerAddress) {
    if (!state.savingServerAddress) actions.cancelServerAddressEdit?.();
    return true;
  }
  if (state.settingsVisible && state.confirmDeleteServer) {
    if (!state.settingsBusy) actions.cancelDeleteServer?.();
    return true;
  }
  if (state.settingsVisible) {
    if (!state.savingServerAddress && !state.settingsBusy) actions.closeSettings();
    return true;
  }
  if (state.filtersVisible) {
    actions.hideFilters();
    return true;
  }
  return false;
}
