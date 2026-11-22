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

interface TransactionFault {
  kind: 'transaction';
  taskIndex: number;
  rejection: Error | string;
}

interface StatementFault {
  kind: 'statement';
  matcher: StatementMatcher;
  rejection: Error | string;
}

type PendingFault = TransactionFault | StatementFault;

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
  clearFaults(): void;
}

export function createSQLiteTestBridge(prefix = 'turnleaf-sqlite-'): SQLiteTestBridge {
  let currentDirectory = '';
  const createdDirectories = new Set<string>();
  const connections = new Map<string, NativeConnectionEntry>();
  let pendingFaults: PendingFault[] = [];
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
        // Ignore rollback errors while tearing down a test handle.
      }
      try {
        entry.handle.close();
      } catch {
        // Ignore duplicate close errors while tearing down a test handle.
      }
    }
    entry.handle = null;
    entry.inTransaction = false;
  }

  function closeAllNativeConnections(): void {
    for (const entry of connections.values()) {
      closeEntryHandle(entry);
    }
    connections.clear();
    transactionTaskIndex = 0;
  }

  function requireConnection(database: string, readonly = false): NativeConnectionEntry {
    const dbName = stripDbSuffix(database);
    const entry = connections.get(connectionKey(dbName, readonly));
    if (!entry) {
      throw new Error(`No available connection for database ${dbName}`);
    }
    return entry;
  }

  function requireOpenHandle(database: string, readonly = false): DatabaseSync {
    const entry = requireConnection(database, readonly);
    if (!entry.handle) {
      throw new Error(`database ${entry.database} not opened`);
    }
    return entry.handle;
  }

  function maybeInjectFault(statement: string, values: unknown[], inTransaction: boolean): void {
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
  }

  function deleteDatabaseFiles(filePath: string): void {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      rmSync(`${filePath}${suffix}`, { force: true });
    }
  }

  const plugin = {
    async createConnection(options: {
      database: string;
      encrypted?: boolean;
      mode?: string;
      version?: number;
      readonly?: boolean;
    }): Promise<void> {
      const dbName = stripDbSuffix(options.database);
      const readonly = Boolean(options.readonly);
      const key = connectionKey(dbName, readonly);
      if (connections.has(key)) {
        throw new Error(`Connection ${dbName} already exists`);
      }
      connections.set(key, {
        database: dbName,
        readonly,
        handle: null,
        inTransaction: false,
      });
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

    async closeConnection(options: { database: string; readonly?: boolean }): Promise<void> {
      const dbName = stripDbSuffix(options.database);
      const readonly = Boolean(options.readonly);
      const entry = requireConnection(dbName, readonly);
      closeEntryHandle(entry);
      connections.delete(connectionKey(dbName, readonly));
    },

    async open(options: { database: string; readonly?: boolean }): Promise<void> {
      const entry = requireConnection(options.database, options.readonly);
      if (!entry.handle) {
        const handle = new DatabaseSync(databasePath(entry.database), {
          readOnly: entry.readonly,
        });
        if (!entry.readonly) {
          handle.exec('PRAGMA foreign_keys = ON;');
        }
        entry.handle = handle;
        entry.inTransaction = false;
      }
    },

    async close(options: { database: string; readonly?: boolean }): Promise<void> {
      const entry = requireConnection(options.database, options.readonly);
      if (!entry.handle) {
        throw new Error(`database ${entry.database} not opened`);
      }
      if (entry.inTransaction) {
        throw new Error(`database ${entry.database} failed to close still in transaction`);
      }
      entry.handle.close();
      entry.handle = null;
    },

    async isDBOpen(options: {
      database: string;
      readonly?: boolean;
    }): Promise<{ result: boolean }> {
      const entry = requireConnection(options.database, options.readonly);
      return { result: entry.handle !== null };
    },

    async isDBExists(options: {
      database: string;
      readonly?: boolean;
    }): Promise<{ result: boolean }> {
      const entry = requireConnection(options.database, options.readonly);
      return { result: existsSync(databasePath(entry.database)) };
    },

    async isDatabase(options: { database: string }): Promise<{ result: boolean }> {
      return { result: existsSync(databasePath(options.database)) };
    },

    async deleteDatabase(options: { database: string; readonly?: boolean }): Promise<void> {
      if (options.readonly) {
        throw new Error('not allowed in read-only mode');
      }
      const entry = requireConnection(options.database, false);
      closeEntryHandle(entry);
      deleteDatabaseFiles(databasePath(entry.database));
    },

    async getVersion(options: {
      database: string;
      readonly?: boolean;
    }): Promise<{ version: number }> {
      const handle = requireOpenHandle(options.database, options.readonly);
      const row = handle.prepare('PRAGMA user_version').get() as
        { user_version?: number } | undefined;
      return { version: Number(row?.user_version ?? 0) };
    },

    async beginTransaction(options: {
      database: string;
    }): Promise<{ changes: { changes: number } }> {
      const entry = requireConnection(options.database, false);
      if (!entry.handle) {
        throw new Error(`database ${entry.database} not opened`);
      }
      if (entry.inTransaction) {
        throw new Error('Already in transaction');
      }
      entry.handle.exec('BEGIN');
      entry.inTransaction = true;
      transactionTaskIndex = 0;
      return { changes: { changes: 0 } };
    },

    async isTransactionActive(options: { database: string }): Promise<{ result: boolean }> {
      const entry = requireConnection(options.database, false);
      if (!entry.handle) {
        throw new Error(`database ${entry.database} not opened`);
      }
      return { result: entry.inTransaction };
    },

    async commitTransaction(options: {
      database: string;
    }): Promise<{ changes: { changes: number } }> {
      const entry = requireConnection(options.database, false);
      if (!entry.handle) {
        throw new Error(`database ${entry.database} not opened`);
      }
      if (!entry.inTransaction) {
        throw new Error('No transaction active');
      }
      try {
        entry.handle.exec('COMMIT');
        return { changes: { changes: 0 } };
      } finally {
        entry.inTransaction = false;
        transactionTaskIndex = 0;
      }
    },

    async rollbackTransaction(options: {
      database: string;
    }): Promise<{ changes: { changes: number } }> {
      const entry = requireConnection(options.database, false);
      if (!entry.handle) {
        throw new Error(`database ${entry.database} not opened`);
      }
      try {
        if (entry.inTransaction) {
          entry.handle.exec('ROLLBACK');
        }
        return { changes: { changes: 0 } };
      } finally {
        entry.inTransaction = false;
        transactionTaskIndex = 0;
      }
    },

    async execute(options: {
      database: string;
      statements: string;
      transaction?: boolean;
      readonly?: boolean;
    }): Promise<{ changes: { changes: number } }> {
      if (options.readonly) {
        throw new Error('not allowed in read-only mode');
      }
      const entry = requireConnection(options.database, false);
      const handle = requireOpenHandle(options.database, false);
      maybeInjectFault(options.statements, [], entry.inTransaction);
      const useTransaction = options.transaction !== false && !entry.inTransaction;
      if (useTransaction) {
        handle.exec('BEGIN');
        try {
          handle.exec(options.statements);
          handle.exec('COMMIT');
        } catch (error) {
          try {
            handle.exec('ROLLBACK');
          } catch {
            // Ignore secondary rollback failure.
          }
          throw error;
        }
      } else {
        handle.exec(options.statements);
      }
      return { changes: { changes: 0 } };
    },

    async run(options: {
      database: string;
      statement: string;
      values?: unknown[];
      transaction?: boolean;
      readonly?: boolean;
      returnMode?: string;
    }): Promise<{ changes: { changes: number; lastId?: number; values?: unknown[] } }> {
      if (options.readonly) {
        throw new Error('not allowed in read-only mode');
      }
      const entry = requireConnection(options.database, false);
      const handle = requireOpenHandle(options.database, false);
      const rawValues = options.values ?? [];
      maybeInjectFault(options.statement, rawValues, entry.inTransaction);
      const sqlValues = normalizeSqlValues(rawValues);
      const useTransaction = options.transaction !== false && !entry.inTransaction;

      const runStatement = () => {
        const prepared = handle.prepare(options.statement);
        if (options.returnMode === 'all') {
          const rows = (prepared.all(...sqlValues) as Record<string, unknown>[]).map((row) => ({
            ...row,
          }));
          return { changes: { changes: rows.length, values: rows } };
        }
        const result = prepared.run(...sqlValues);
        return {
          changes: {
            changes: Number(result.changes ?? 0),
            lastId: Number(result.lastInsertRowid ?? -1),
          },
        };
      };

      if (useTransaction) {
        handle.exec('BEGIN');
        try {
          const result = runStatement();
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

      return runStatement();
    },

    async query(options: {
      database: string;
      statement: string;
      values?: unknown[];
      readonly?: boolean;
    }): Promise<{ values: Record<string, unknown>[] }> {
      const entry = requireConnection(options.database, options.readonly);
      const handle = requireOpenHandle(options.database, options.readonly);
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
      closeAllNativeConnections();
      pendingFaults = [];
      transactionTaskIndex = 0;
      totalStatementIndex = 0;
      currentDirectory = mkdtempSync(join(tmpdir(), nextPrefix));
      createdDirectories.add(currentDirectory);
      return currentDirectory;
    },
    cleanup(): void {
      closeAllNativeConnections();
      pendingFaults = [];
      transactionTaskIndex = 0;
      totalStatementIndex = 0;
      for (const dir of createdDirectories) {
        rmSync(dir, { recursive: true, force: true });
      }
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
      return (
        connections.get(connectionKey(database, readonly))?.handle !== null &&
        connections.has(connectionKey(database, readonly))
      );
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
      pendingFaults.push({
        kind: 'statement',
        matcher,
        rejection,
      });
    },
    clearFaults(): void {
      pendingFaults = [];
    },
  };
}
