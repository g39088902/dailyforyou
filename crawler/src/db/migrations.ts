import logger from "../utils/logger.js";
import { executeSql, queryRows, runBatch } from "./client.js";

interface Migration {
  version: string;
  description: string;
  statements: string[];
}

const LEDGER_TABLE = "crawler_migrations";

/**
 * 爬虫服务只负责新闻库（news_items）。
 * 用户、评分、Prompt 相关的表由 backend（用户服务）独立管理，两边互不写入。
 */
const MIGRATIONS: Migration[] = [
  {
    version: "c001_news_schema",
    description: "新闻正文表（抓取与翻译结果）",
    statements: [
      `CREATE TABLE IF NOT EXISTS news_items (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        news_hash      TEXT NOT NULL UNIQUE,
        source         TEXT NOT NULL DEFAULT '',
        title          TEXT NOT NULL DEFAULT '',
        desc_text      TEXT NOT NULL DEFAULT '',
        url            TEXT NOT NULL DEFAULT '',
        formatted_text TEXT NOT NULL DEFAULT '',
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_news_items_created ON news_items(created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_news_items_source ON news_items(source)`,
    ],
  },
];

let migrationPromise: Promise<void> | null = null;

/**
 * 执行爬虫侧迁移（幂等）
 */
export const runCrawlerMigrations = async (): Promise<void> => {
  if (migrationPromise) return migrationPromise;

  migrationPromise = (async () => {
    await executeSql(`
      CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
        version     TEXT PRIMARY KEY,
        description TEXT NOT NULL DEFAULT '',
        applied_at  TEXT NOT NULL
      )
    `);

    const appliedRows = await queryRows(`SELECT version FROM ${LEDGER_TABLE}`);
    const applied = new Set(appliedRows.map((row) => String(row.version)));

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;

      const startedAt = Date.now();
      await runBatch(migration.statements.map((sql) => ({ sql })));
      await executeSql(
        `INSERT INTO ${LEDGER_TABLE} (version, description, applied_at) VALUES (?, ?, ?)`,
        [migration.version, migration.description, new Date().toISOString()],
      );
      logger.info(
        `✅ [CrawlerMigration] ${migration.version} 已应用（${Date.now() - startedAt}ms）`,
      );
    }
  })().catch((error) => {
    migrationPromise = null;
    throw error;
  });

  return migrationPromise;
};
