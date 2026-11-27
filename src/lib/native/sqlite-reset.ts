import * as CapacitorCore from '@capacitor/core';

export interface SqliteResetPlugin {
  deleteDatabase(options?: { database?: 'turnleaf' }): Promise<void>;
}

let cachedPlugin: SqliteResetPlugin | null = null;

function resolveSqliteResetPlugin(): SqliteResetPlugin | null {
  if (cachedPlugin) return cachedPlugin;
  try {
    if ('registerPlugin' in CapacitorCore && typeof CapacitorCore.registerPlugin === 'function') {
      cachedPlugin = CapacitorCore.registerPlugin<SqliteResetPlugin>('SqliteReset');
      return cachedPlugin;
    }
  } catch {
    return null;
  }
  return null;
}

export const SqliteReset: SqliteResetPlugin = {
  async deleteDatabase(options = { database: 'turnleaf' }): Promise<void> {
    const plugin = resolveSqliteResetPlugin();
    if (!plugin) {
      throw new Error('SqliteReset plugin registration is unavailable.');
    }
    await plugin.deleteDatabase(options);
  },
};

export function hasNativeSqliteResetPlugin(): boolean {
  return resolveSqliteResetPlugin() !== null;
}
