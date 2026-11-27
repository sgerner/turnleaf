export type BackButtonHandler = () => boolean;
export type RegisterBackHandler = (handler: BackButtonHandler) => () => void;

export function createBackButtonStack(options: { exitApp: () => void }) {
  const handlers: BackButtonHandler[] = [];

  return {
    register(handler: BackButtonHandler): () => void {
      handlers.push(handler);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const index = handlers.lastIndexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
    dispatch(): boolean {
      for (let index = handlers.length - 1; index >= 0; index -= 1) {
        if (handlers[index]?.()) return true;
      }
      options.exitApp();
      return false;
    },
    clear(): void {
      handlers.length = 0;
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

export function handleLibraryBack(options: {
  hasConflict: boolean;
  acceptingRemoteProgress: boolean;
  hasActionMenu: boolean;
  hasOpenReader: boolean;
  editingServerAddress?: boolean;
  savingServerAddress?: boolean;
  settingsBusy?: boolean;
  settingsVisible: boolean;
  filtersVisible: boolean;
  closeConflict: () => void;
  closeActionMenu: () => void;
  closeReader: () => void;
  cancelServerAddressEdit?: () => void;
  closeSettings: () => void;
  closeFilters: () => void;
}): boolean {
  if (options.hasConflict) {
    if (!options.acceptingRemoteProgress) options.closeConflict();
    return true;
  }
  if (options.hasActionMenu) {
    options.closeActionMenu();
    return true;
  }
  if (options.hasOpenReader) {
    options.closeReader();
    return true;
  }
  if (options.settingsVisible && options.editingServerAddress) {
    if (!options.savingServerAddress) options.cancelServerAddressEdit?.();
    return true;
  }
  if (options.settingsVisible) {
    if (!options.savingServerAddress && !options.settingsBusy) options.closeSettings();
    return true;
  }
  if (options.filtersVisible) {
    options.closeFilters();
    return true;
  }
  return false;
}
