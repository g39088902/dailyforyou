import logger from "../utils/logger.js";
import { executeSql, queryRows, runBatch } from "./client.js";
import { seedSourcesFromRegistry } from "./sourcesRepo.js";

interface Migration {
  version: string;
  description: string;
  statements?: string[];
  run?: () => Promise<void>;
}

const LEDGER_TABLE = "crawler_migrations";

/**
 * 爬虫服务负责新闻库（news_items）。
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
  {
    version: "c002_news_columns",
    description: "扩展新闻信源英文别名、分类及卡片元数据字段",
    run: async () => {
      const columns = await queryRows(`PRAGMA table_info(news_items)`);
      const existing = new Set(columns.map((row: any) => String(row.name)));

      const statements: string[] = [];
      const newCols: Record<string, string> = {
        source_name: "TEXT NOT NULL DEFAULT ''",
        sub_type: "TEXT NOT NULL DEFAULT ''",
        hot: "TEXT NOT NULL DEFAULT ''",
        cover: "TEXT NOT NULL DEFAULT ''",
        mobile_url: "TEXT NOT NULL DEFAULT ''",
        pub_time: "TEXT NOT NULL DEFAULT ''",
      };

      for (const [col, colDef] of Object.entries(newCols)) {
        if (!existing.has(col)) {
          statements.push(`ALTER TABLE news_items ADD COLUMN ${col} ${colDef}`);
        }
      }

      for (const sql of statements) {
        await executeSql(sql);
      }

      await executeSql(
        `CREATE INDEX IF NOT EXISTS idx_news_items_query ON news_items(source_name, sub_type, id DESC)`,
      );
    },
  },
  {
    version: "c003_sources_registry",
    description: "信源清单表、图标表、版本握手表与抓取历史表",
    run: async () => {
      await executeSql(`
        CREATE TABLE IF NOT EXISTS sources (
          key                  TEXT PRIMARY KEY,
          name                 TEXT NOT NULL,
          sub_type             TEXT NOT NULL DEFAULT '',
          params_json          TEXT NOT NULL DEFAULT '{}',
          label                TEXT NOT NULL,
          category             TEXT NOT NULL DEFAULT '',
          type                 TEXT NOT NULL DEFAULT '',
          link                 TEXT NOT NULL DEFAULT '',
          logo_url             TEXT NOT NULL DEFAULT '',
          logo_text            TEXT NOT NULL DEFAULT '',
          logo_color           TEXT NOT NULL DEFAULT '#5F5E5A',
          has_logo             INTEGER NOT NULL DEFAULT 0,
          logo_etag            TEXT NOT NULL DEFAULT '',
          sort_order           INTEGER NOT NULL DEFAULT 0,
          default_on           INTEGER NOT NULL DEFAULT 1,
          enabled              INTEGER NOT NULL DEFAULT 1,
          retired              INTEGER NOT NULL DEFAULT 0,
          status               TEXT NOT NULL DEFAULT 'idle',
          last_started_at      TEXT NOT NULL DEFAULT '',
          last_finished_at     TEXT NOT NULL DEFAULT '',
          last_success_at      TEXT NOT NULL DEFAULT '',
          last_error           TEXT NOT NULL DEFAULT '',
          items_total          INTEGER NOT NULL DEFAULT 0,
          items_last_run       INTEGER NOT NULL DEFAULT 0,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          updated_at           TEXT NOT NULL DEFAULT ''
        )
      `);
      await executeSql(`CREATE INDEX IF NOT EXISTS idx_sources_order ON sources(sort_order)`);

      await executeSql(`
        CREATE TABLE IF NOT EXISTS source_logos (
          key         TEXT PRIMARY KEY,
          mime        TEXT NOT NULL,
          bytes       BLOB NOT NULL,
          width       INTEGER NOT NULL DEFAULT 0,
          height      INTEGER NOT NULL DEFAULT 0,
          source_file TEXT NOT NULL DEFAULT '',
          updated_at  TEXT NOT NULL
        )
      `);

      await executeSql(`
        CREATE TABLE IF NOT EXISTS schema_meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      await executeSql(
        `INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('news_schema_version', '3')`,
      );

      await executeSql(`
        CREATE TABLE IF NOT EXISTS crawl_runs (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id        TEXT NOT NULL,
          source_key    TEXT NOT NULL,
          started_at    TEXT NOT NULL,
          finished_at   TEXT NOT NULL DEFAULT '',
          status        TEXT NOT NULL DEFAULT 'running',
          items_written INTEGER NOT NULL DEFAULT 0,
          error         TEXT NOT NULL DEFAULT ''
        )
      `);
      await executeSql(
        `CREATE INDEX IF NOT EXISTS idx_crawl_runs_key ON crawl_runs(source_key, started_at DESC)`,
      );

      // 初始数据种子注入
      await seedSourcesFromRegistry();
    },
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
      if (migration.run) {
        await migration.run();
      } else if (migration.statements?.length) {
        await runBatch(migration.statements.map((sql) => ({ sql })));
      }
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
