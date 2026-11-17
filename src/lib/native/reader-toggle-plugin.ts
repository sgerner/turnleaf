export interface ReaderTogglePlugin {
  setEnabled(options: { enabled: boolean }): Promise<void>;
}
