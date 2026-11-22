export interface ReaderBackState {
  pendingSyncLocation: boolean;
  settingsVisible: boolean;
  tocVisible: boolean;
  bookmarksVisible: boolean;
  annotationsVisible: boolean;
  searchVisible: boolean;
  hasLinkReturnTarget: boolean;
  controlsVisible: boolean;
  footerVisible: boolean;
}

export interface ReaderBackActions {
  closeSyncConfirmation: () => void;
  closeSettings: () => void;
  closeToc: () => void;
  closeBookmarks: () => void;
  closeAnnotations: () => void;
  closeSearch: () => void;
  returnToLink: () => void;
  hideChrome: () => void;
  pauseChromeHide: () => void;
  focusTopReveal: () => void;
  showControls: () => void;
  onBack: () => void;
}

export function handleReaderBack(state: ReaderBackState, actions: ReaderBackActions): boolean {
  if (state.pendingSyncLocation) {
    actions.closeSyncConfirmation();
    actions.showControls();
    return true;
  }
  if (state.settingsVisible) {
    actions.closeSettings();
    actions.showControls();
    return true;
  }
  if (state.tocVisible) {
    actions.closeToc();
    actions.showControls();
    return true;
  }
  if (state.bookmarksVisible) {
    actions.closeBookmarks();
    actions.showControls();
    return true;
  }
  if (state.annotationsVisible) {
    actions.closeAnnotations();
    actions.showControls();
    return true;
  }
  if (state.searchVisible) {
    actions.closeSearch();
    actions.showControls();
    return true;
  }
  if (state.hasLinkReturnTarget) {
    actions.returnToLink();
    actions.showControls();
    return true;
  }
  if (state.controlsVisible || state.footerVisible) {
    actions.hideChrome();
    actions.pauseChromeHide();
    actions.focusTopReveal();
    return true;
  }
  actions.onBack();
  return true;
}
