export type BackButtonHandler = () => boolean;
export type RegisterBackHandler = (handler: BackButtonHandler) => () => void;

export function createBackButtonStack(options: { exitApp: () => void }) {
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
      options.exitApp();
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

export function handleLibraryBack(options: {
  hasConflict: boolean;
  acceptingRemoteProgress: boolean;
  hasActionMenu: boolean;
  hasOpenReader: boolean;
  editingServerAddress?: boolean;
  savingServerAddress?: boolean;
  confirmDeleteServer?: boolean;
  settingsBusy?: boolean;
  settingsVisible: boolean;
  filtersVisible: boolean;
  closeConflict: () => void;
  closeActionMenu: () => void;
  closeReader: () => void;
  cancelServerAddressEdit?: () => void;
  cancelDeleteServer?: () => void;
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
  if (options.settingsVisible && options.confirmDeleteServer) {
    if (!options.settingsBusy) options.cancelDeleteServer?.();
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
