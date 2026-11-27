import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';

interface NativeConnectionEntry {
  database: string;
  readonly: boolean;
  handle: DatabaseSync | null;
  inTransaction: boolean;
}

type StatementMatcher =
  string | RegExp | ((statement: string, values: unknown[], statementIndex: number) => boolean);

type TransactionTaskHandler = (taskIndex: number) => void | Promise<void>;

type DbOptions = { database: string; readonly?: boolean };
type PendingFault =
  | { kind: 'transaction'; taskIndex: number; rejection: Error | string }
  | { kind: 'statement'; matcher: StatementMatcher; rejection: Error | string };

function stripDbSuffix(database: string): string {
  return database.endsWith('.db') ? database.slice(0, -3) : database;
}

function connectionKey(database: string, readonly = false): string {
  return `${readonly ? 'RO' : 'RW'}_${stripDbSuffix(database)}`;
}

function normalizeSqlValues(values: unknown[] = []): SQLInputValue[] {
  return values.map((value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value as SQLInputValue;
  });
}

function matchesStatement(
  matcher: StatementMatcher,
  statement: string,
  values: unknown[],
  statementIndex: number,
): boolean {
  if (typeof matcher === 'string') return statement.includes(matcher);
  if (matcher instanceof RegExp) return matcher.test(statement);
  return matcher(statement, values, statementIndex);
}

export interface SQLiteTestBridge {
  readonly plugin: Record<string, (...args: never[]) => Promise<unknown>>;
  readonly directory: string;
  useNewDirectory(prefix?: string): string;
  cleanup(): void;
  databasePath(database?: string): string;
  openDirect(database?: string): DatabaseSync;
  hasNativeConnection(database?: string, readonly?: boolean): boolean;
  isNativeHandleOpen(database?: string, readonly?: boolean): boolean;
  failTransactionAt(taskIndex: number, rejection?: Error | string): void;
  failStatement(matcher: StatementMatcher, rejection?: Error | string): void;
  onTransactionTask(handler: TransactionTaskHandler | null): void;
  clearFaults(): void;
}

export function createSQLiteTestBridge(prefix = 'turnleaf-sqlite-'): SQLiteTestBridge {
  let currentDirectory = '';
  const createdDirectories = new Set<string>();
  const connections = new Map<string, NativeConnectionEntry>();
  let pendingFaults: PendingFault[] = [];
  let transactionTaskHandler: TransactionTaskHandler | null = null;
  let transactionTaskIndex = 0;
  let totalStatementIndex = 0;

  function ensureDirectory(): string {
    if (!currentDirectory) {
      currentDirectory = mkdtempSync(join(tmpdir(), prefix));
      createdDirectories.add(currentDirectory);
    }
    return currentDirectory;
  }

  function databasePath(database = 'turnleaf'): string {
    return join(ensureDirectory(), `${stripDbSuffix(database)}SQLite.db`);
  }

  function closeEntryHandle(entry: NativeConnectionEntry): void {
    if (entry.handle) {
      try {
        if (entry.inTransaction) entry.handle.exec('ROLLBACK');
      } catch {
        // Ignore rollback errors during teardown.
      }
      try {
        entry.handle.close();
      } catch {
        // Ignore duplicate close errors during teardown.
      }
    }
    entry.handle = null;
    entry.inTransaction = false;
  }

  function closeAllNativeConnections(): void {
    for (const entry of connections.values()) closeEntryHandle(entry);
    connections.clear();
    transactionTaskIndex = 0;
  }

  function requireConnection(database: string, readonly = false): NativeConnectionEntry {
    const dbName = stripDbSuffix(database);
    const entry = connections.get(connectionKey(dbName, readonly));
    if (!entry) throw new Error(`No available connection for database ${dbName}`);
    return entry;
  }

  function resetBridgeState(): void {
    closeAllNativeConnections();
    pendingFaults = [];
    transactionTaskHandler = null;
    transactionTaskIndex = 0;
    totalStatementIndex = 0;
  }

  function requireOpenEntry(
    database: string,
    readonly = false,
  ): { entry: NativeConnectionEntry; handle: DatabaseSync } {
    const entry = requireConnection(database, readonly);
    if (!entry.handle) throw new Error(`database ${entry.database} not opened`);
    return { entry, handle: entry.handle };
  }

  function runWithOptionalTransaction<T>(
    handle: DatabaseSync,
    useTransaction: boolean,
    run: () => T,
  ): T {
    if (!useTransaction) return run();
    handle.exec('BEGIN');
    try {
      const result = run();
      handle.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        handle.exec('ROLLBACK');
      } catch {
        // Ignore secondary rollback failure.
      }
      throw error;
    }
  }

  function maybeInjectFault(statement: string, values: unknown[], inTransaction: boolean): number {
    const statementIndex = totalStatementIndex++;
    const currentTaskIndex = inTransaction ? transactionTaskIndex++ : -1;
    for (let i = 0; i < pendingFaults.length; i += 1) {
      const fault = pendingFaults[i]!;
      const matched =
        fault.kind === 'transaction'
          ? inTransaction && currentTaskIndex === fault.taskIndex
          : matchesStatement(fault.matcher, statement, values, statementIndex);
      if (matched) {
        pendingFaults.splice(i, 1);
        throw fault.rejection;
      }
    }
    return currentTaskIndex;
  }

  const plugin = {
    async createConnection(options: DbOptions): Promise<void> {
      const dbName = stripDbSuffix(options.database);
      const readonly = Boolean(options.readonly);
      const key = connectionKey(dbName, readonly);
      if (connections.has(key)) throw new Error(`Connection ${dbName} already exists`);
      connections.set(key, { database: dbName, readonly, handle: null, inTransaction: false });
    },

    async checkConnectionsConsistency(options: {
      dbNames?: string[];
      openModes?: string[];
    }): Promise<{ result: boolean }> {
      const dbNames = options.dbNames ?? [];
      const openModes = options.openModes ?? [];
      const jsKeys = new Set(
        dbNames.map((name, index) => `${openModes[index] ?? 'RW'}_${stripDbSuffix(name)}`),
      );
      if (jsKeys.size === 0 || connections.size < jsKeys.size) {
        closeAllNativeConnections();
        return { result: false };
      }
      for (const [key, entry] of [...connections.entries()]) {
        if (!jsKeys.has(key)) {
          closeEntryHandle(entry);
          connections.delete(key);
        }
      }
      if (connections.size === jsKeys.size && [...jsKeys].every((key) => connections.has(key))) {
        return { result: true };
      }
      closeAllNativeConnections();
      return { result: false };
    },

    async closeConnection(options: DbOptions): Promise<void> {
      const dbName = stripDbSuffix(options.database);
      const readonly = Boolean(options.readonly);
      closeEntryHandle(requireConnection(dbName, readonly));
      connections.delete(connectionKey(dbName, readonly));
    },

    async open(options: DbOptions): Promise<void> {
      const entry = requireConnection(options.database, options.readonly);
      if (!entry.handle) {
        const handle = new DatabaseSync(databasePath(entry.database), { readOnly: entry.readonly });
        if (!entry.readonly) handle.exec('PRAGMA foreign_keys = ON;');
        entry.handle = handle;
        entry.inTransaction = false;
      }
    },

    async close(options: DbOptions): Promise<void> {
      const { entry, handle } = requireOpenEntry(options.database, options.readonly);
      if (entry.inTransaction) {
        throw new Error(`database ${entry.database} failed to close still in transaction`);
      }
      handle.close();
      entry.handle = null;
    },

    async isDBOpen(options: DbOptions): Promise<{ result: boolean }> {
      return { result: requireConnection(options.database, options.readonly).handle !== null };
    },

    async isDBExists(options: DbOptions): Promise<{ result: boolean }> {
      const entry = requireConnection(options.database, options.readonly);
      return { result: existsSync(databasePath(entry.database)) };
    },

    async isDatabase(options: { database: string }): Promise<{ result: boolean }> {
      return { result: existsSync(databasePath(options.database)) };
    },

    async deleteDatabase(options: DbOptions): Promise<void> {
      if (options.readonly) throw new Error('not allowed in read-only mode');
      const entry = requireConnection(options.database, false);
      closeEntryHandle(entry);
      const filePath = databasePath(entry.database);
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        rmSync(`${filePath}${suffix}`, { force: true });
      }
    },

    async getVersion(options: DbOptions): Promise<{ version: number }> {
      const { handle } = requireOpenEntry(options.database, options.readonly);
      const row = handle.prepare('PRAGMA user_version').get() as
        { user_version?: number } | undefined;
      return { version: Number(row?.user_version ?? 0) };
    },

    async beginTransaction(options: {
      database: string;
    }): Promise<{ changes: { changes: number } }> {
      const { entry, handle } = requireOpenEntry(options.database, false);
      if (entry.inTransaction) throw new Error('Already in transaction');
      handle.exec('BEGIN');
      entry.inTransaction = true;
      transactionTaskIndex = 0;
      return { changes: { changes: 0 } };
    },

    async isTransactionActive(options: { database: string }): Promise<{ result: boolean }> {
      return { result: requireOpenEntry(options.database, false).entry.inTransaction };
    },

    async commitTransaction(options: {
      database: string;
    }): Promise<{ changes: { changes: number } }> {
      const { entry, handle } = requireOpenEntry(options.database, false);
      if (!entry.inTransaction) throw new Error('No transaction active');
      try {
        handle.exec('COMMIT');
        return { changes: { changes: 0 } };
      } finally {
        entry.inTransaction = false;
        transactionTaskIndex = 0;
      }
    },

    async rollbackTransaction(options: {
      database: string;
    }): Promise<{ changes: { changes: number } }> {
      const { entry, handle } = requireOpenEntry(options.database, false);
      try {
        if (entry.inTransaction) handle.exec('ROLLBACK');
        return { changes: { changes: 0 } };
      } finally {
        entry.inTransaction = false;
        transactionTaskIndex = 0;
      }
    },

    async execute(
      options: DbOptions & { statements: string; transaction?: boolean },
    ): Promise<{ changes: { changes: number } }> {
      if (options.readonly) throw new Error('not allowed in read-only mode');
      const { entry, handle } = requireOpenEntry(options.database, false);
      const taskIndex = maybeInjectFault(options.statements, [], entry.inTransaction);
      runWithOptionalTransaction(
        handle,
        options.transaction !== false && !entry.inTransaction,
        () => handle.exec(options.statements),
      );
      if (taskIndex >= 0 && transactionTaskHandler) await transactionTaskHandler(taskIndex);
      return { changes: { changes: 0 } };
    },

    async run(
      options: DbOptions & {
        statement: string;
        values?: unknown[];
        transaction?: boolean;
        returnMode?: string;
      },
    ): Promise<{ changes: { changes: number; lastId?: number; values?: unknown[] } }> {
      if (options.readonly) throw new Error('not allowed in read-only mode');
      const { entry, handle } = requireOpenEntry(options.database, false);
      const rawValues = options.values ?? [];
      const taskIndex = maybeInjectFault(options.statement, rawValues, entry.inTransaction);
      const sqlValues = normalizeSqlValues(rawValues);
      const useTransaction = options.transaction !== false && !entry.inTransaction;
      const result = runWithOptionalTransaction(handle, useTransaction, () => {
        const prepared = handle.prepare(options.statement);
        if (options.returnMode === 'all') {
          const rows = (prepared.all(...sqlValues) as Record<string, unknown>[]).map((row) => ({
            ...row,
          }));
          return { changes: { changes: rows.length, values: rows } };
        }
        const runResult = prepared.run(...sqlValues);
        return {
          changes: {
            changes: Number(runResult.changes ?? 0),
            lastId: Number(runResult.lastInsertRowid ?? -1),
          },
        };
      });
      if (!useTransaction && taskIndex >= 0 && transactionTaskHandler) {
        await transactionTaskHandler(taskIndex);
      }
      return result;
    },

    async query(
      options: DbOptions & { statement: string; values?: unknown[] },
    ): Promise<{ values: Record<string, unknown>[] }> {
      const { entry, handle } = requireOpenEntry(options.database, options.readonly);
      const rawValues = options.values ?? [];
      maybeInjectFault(options.statement, rawValues, entry.inTransaction);
      const rows = handle
        .prepare(options.statement)
        .all(...normalizeSqlValues(rawValues)) as Record<string, unknown>[];
      return { values: rows.map((row) => ({ ...row })) };
    },
  };

  return {
    plugin: plugin as unknown as Record<string, (...args: never[]) => Promise<unknown>>,
    get directory(): string {
      return ensureDirectory();
    },
    useNewDirectory(nextPrefix = prefix): string {
      resetBridgeState();
      currentDirectory = mkdtempSync(join(tmpdir(), nextPrefix));
      createdDirectories.add(currentDirectory);
      return currentDirectory;
    },
    cleanup(): void {
      resetBridgeState();
      for (const dir of createdDirectories) rmSync(dir, { recursive: true, force: true });
      createdDirectories.clear();
      currentDirectory = '';
    },
    databasePath,
    openDirect(database = 'turnleaf'): DatabaseSync {
      const db = new DatabaseSync(databasePath(database));
      db.exec('PRAGMA foreign_keys = ON;');
      return db;
    },
    hasNativeConnection(database = 'turnleaf', readonly = false): boolean {
      return connections.has(connectionKey(database, readonly));
    },
    isNativeHandleOpen(database = 'turnleaf', readonly = false): boolean {
      return connections.get(connectionKey(database, readonly))?.handle != null;
    },
    failTransactionAt(
      taskIndex: number,
      rejection: Error | string = new Error(`injected transaction failure at ${taskIndex}`),
    ): void {
      pendingFaults.push({
        kind: 'transaction',
        taskIndex,
        rejection: typeof rejection === 'string' ? new Error(rejection) : rejection,
      });
    },
    failStatement(
      matcher: StatementMatcher,
      rejection: Error | string = new Error('injected statement failure'),
    ): void {
      pendingFaults.push({ kind: 'statement', matcher, rejection });
    },
    onTransactionTask(handler: TransactionTaskHandler | null): void {
      transactionTaskHandler = handler;
    },
    clearFaults(): void {
      pendingFaults = [];
      transactionTaskHandler = null;
    },
  };
}
