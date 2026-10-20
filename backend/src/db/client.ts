import { DatabaseSync } from "node:sqlite";
import { createClient, type Client } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import logger from "../utils/logger.js";

export interface BatchStatement {
  sql: string;
  args?: Array<string | number | null>;
}

let libsqlClient: Client | null = null;
let localDbInstance: DatabaseSync | null = null;
let openPromise: Promise<void> | null = null;

/**
 * 当前是否使用远程 libSQL
 */
export const isRemoteDatabase = (): boolean => Boolean(config.LIBSQL_URL);

/**
 * 建立数据库连接（只连接，不建表；建表由 migrations 负责）
 */
export const openDatabase = async (): Promise<void> => {
  if (openPromise) return openPromise;

  openPromise = (async () => {
    if (config.LIBSQL_URL) {
      libsqlClient = createClient({
        url: config.LIBSQL_URL,
        authToken: config.LIBSQL_AUTH_TOKEN || undefined,
      });
      logger.info(`🌐 [Database] Connected to remote libSQL at ${config.LIBSQL_URL}`);
      return;
    }

    const dbPath = path.resolve(process.cwd(), config.SQLITE_DB_PATH || "./data/scores.sqlite");
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    const db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
    `);
    localDbInstance = db;
    logger.info(`🗄️ [Database] Local SQLite ready at ${dbPath}`);
  })();

  return openPromise;
};

const ensureOpen = async (): Promise<void> => {
  if (!libsqlClient && !localDbInstance) {
    await openDatabase();
  }
};

/**
 * 统一查询并返回单条记录
 */
export const queryOne = async (sql: string, args: any[] = []): Promise<any | null> => {
  await ensureOpen();
  if (libsqlClient) {
    const res = await libsqlClient.execute({ sql, args });
    if (!res.rows || res.rows.length === 0) return null;
    return res.rows[0];
  }
  const row = localDbInstance!.prepare(sql).get(...args);
  return row ?? null;
};

/**
 * 统一查询并返回多条记录
 */
export const queryRows = async (sql: string, args: any[] = []): Promise<any[]> => {
  await ensureOpen();
  if (libsqlClient) {
    const res = await libsqlClient.execute({ sql, args });
    return res.rows ? [...res.rows] : [];
  }
  return localDbInstance!.prepare(sql).all(...args) ?? [];
};

/**
 * 统一执行写入/更新语句
 */
export const executeSql = async (sql: string, args: any[] = []): Promise<void> => {
  await ensureOpen();
  if (libsqlClient) {
    await libsqlClient.execute({ sql, args });
    return;
  }
  if (args.length > 0) {
    localDbInstance!.prepare(sql).run(...args);
  } else {
    localDbInstance!.exec(sql);
  }
};

/**
 * 执行写入并返回受影响行数（远程取 rowsAffected，本地取 changes）
 * 主要用于 nonce 一次性消费这类需要原子性判断的场景
 */
export const executeAffected = async (sql: string, args: any[] = []): Promise<number> => {
  await ensureOpen();
  if (libsqlClient) {
    const res = await libsqlClient.execute({ sql, args });
    return Number(res.rowsAffected ?? 0);
  }
  const result = localDbInstance!.prepare(sql).run(...args);
  return Number(result.changes ?? 0);
};

/**
 * 原子批量执行（远程使用 libSQL batch 事务，本地使用 BEGIN/COMMIT）
 */
export const runBatch = async (statements: BatchStatement[]): Promise<void> => {
  if (statements.length === 0) return;
  await ensureOpen();

  if (libsqlClient) {
    await libsqlClient.batch(
      statements.map((item) => ({ sql: item.sql, args: item.args ?? [] })),
      "write",
    );
    return;
  }

  const db = localDbInstance!;
  db.exec("BEGIN");
  try {
    for (const item of statements) {
      const stmt = db.prepare(item.sql);
      stmt.run(...(item.args ?? []));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};

/**
 * 关闭数据库连接（供优雅退出使用）
 */
export const closeDatabase = async (): Promise<void> => {
  if (libsqlClient) {
    libsqlClient.close();
    libsqlClient = null;
  }
  if (localDbInstance) {
    try {
      localDbInstance.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // ignore checkpoint failure
    }
    localDbInstance.close();
    localDbInstance = null;
  }
  openPromise = null;
};
