import { config } from "../config.js";
import logger from "./logger.js";
import { executeSql, queryOne, queryRows, runBatch, type BatchStatement } from "../db/client.js";
import { DEFAULT_SCORE_PROMPT, hashPrompt } from "./scorePrompt.js";

export interface MigrationContext {
  now: string;
}

export interface Migration {
  version: string;
  description: string;
  statements?: string[];
  run?: (ctx: MigrationContext) => Promise<string | undefined>;
}

/** 用户服务独立迁移账本（爬虫使用 crawler_migrations，两边互不干扰） */
const LEDGER_TABLE = "user_migrations";

const CORE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    display_name  TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'active',
    token_version INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS auth_identities (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL,
    provider         TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    provider_meta    TEXT NOT NULL DEFAULT '{}',
    created_at       TEXT NOT NULL,
    last_login_at    TEXT,
    UNIQUE(provider, provider_user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_auth_identities_user ON auth_identities(user_id)`,
  `CREATE TABLE IF NOT EXISTS auth_nonces (
    nonce       TEXT PRIMARY KEY,
    address     TEXT NOT NULL,
    provider    TEXT NOT NULL DEFAULT 'ethereum',
    message     TEXT NOT NULL,
    issued_at   TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    consumed_at TEXT,
    attempts    INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_auth_nonces_expires ON auth_nonces(expires_at)`,
  `CREATE TABLE IF NOT EXISTS user_profiles (
    user_id           INTEGER PRIMARY KEY,
    score_prompt      TEXT NOT NULL,
    prompt_hash       TEXT NOT NULL,
    prompt_updated_at TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS user_news_states (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL,
    news_hash        TEXT NOT NULL,
    ai_score         INTEGER NOT NULL DEFAULT -1,
    ai_layer         TEXT NOT NULL DEFAULT 'Uncertain',
    ai_reason        TEXT NOT NULL DEFAULT '',
    ai_model         TEXT NOT NULL DEFAULT '',
    prompt_hash      TEXT NOT NULL DEFAULT '',
    user_score       INTEGER,
    user_layer       TEXT,
    user_reason      TEXT,
    is_user_modified INTEGER NOT NULL DEFAULT 0,
    user_updated_at  TEXT,
    is_read          INTEGER NOT NULL DEFAULT 0,
    read_at          TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    UNIQUE(user_id, news_hash)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_uns_user_modified ON user_news_states(user_id, is_user_modified)`,
  `CREATE INDEX IF NOT EXISTS idx_uns_user_read ON user_news_states(user_id, is_read, read_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_uns_user_updated ON user_news_states(user_id, updated_at DESC)`,
];

const MIGRATIONS: Migration[] = [
  {
    version: "u001_core_schema",
    description: "用户、身份、nonce、画像与用户新闻状态表",
    statements: CORE_SCHEMA,
  },
  {
    version: "u002_seed_default_user",
    description: "创建默认账户及其默认评分 Prompt",
    run: async ({ now }) => {
      await executeSql(
        `INSERT OR IGNORE INTO users (id, display_name, status, token_version, created_at, updated_at)
         VALUES (?, ?, 'active', 0, ?, ?)`,
        [config.DEFAULT_USER_ID, "默认账户", now, now],
      );
      await executeSql(
        `INSERT OR IGNORE INTO user_profiles
           (user_id, score_prompt, prompt_hash, prompt_updated_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [config.DEFAULT_USER_ID, DEFAULT_SCORE_PROMPT, hashPrompt(DEFAULT_SCORE_PROMPT), now, now, now],
      );
      return `user_id=${config.DEFAULT_USER_ID}`;
    },
  },
  {
    version: "u003_state_index_fields",
    description: "user_news_states 增加最小索引字段（source/title/url）",
    run: async () => {
      const columns = await queryRows(`PRAGMA table_info(user_news_states)`);
      const existing = new Set(columns.map((row: any) => String(row.name)));

      const statements: BatchStatement[] = [];
      for (const column of ["source", "title", "url"]) {
        if (!existing.has(column)) {
          statements.push({
            sql: `ALTER TABLE user_news_states ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`,
          });
        }
      }
      if (statements.length > 0) {
        await runBatch(statements);
      }

      // 一次性回填：从爬虫的新闻表补齐历史记录的索引字段（仅迁移期读取，运行期不依赖该表）
      const newsTable = await queryOne(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'news_items'`,
      );
      if (!newsTable) {
        return `新增列 ${statements.length} 个；新闻表不存在，跳过回填`;
      }

      await executeSql(`
        UPDATE user_news_states
        SET source = COALESCE((SELECT n.source FROM news_items n WHERE n.news_hash = user_news_states.news_hash), source),
            title  = COALESCE((SELECT n.title  FROM news_items n WHERE n.news_hash = user_news_states.news_hash), title),
            url    = COALESCE((SELECT n.url    FROM news_items n WHERE n.news_hash = user_news_states.news_hash), url)
        WHERE EXISTS (SELECT 1 FROM news_items n WHERE n.news_hash = user_news_states.news_hash)
      `);

      const filled = await queryOne(
        `SELECT COUNT(*) AS total FROM user_news_states WHERE title != ''`,
      );
      return `新增列 ${statements.length} 个；已回填 ${Number(filled?.total ?? 0)} 条索引`;
    },
  },
];

let migrationPromise: Promise<void> | null = null;

/**
 * 执行用户服务迁移（幂等）
 */
export const runMigrations = async (): Promise<void> => {
  if (migrationPromise) return migrationPromise;

  migrationPromise = (async () => {
    await executeSql(`
      CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
        version     TEXT PRIMARY KEY,
        description TEXT NOT NULL DEFAULT '',
        applied_at  TEXT NOT NULL,
        note        TEXT NOT NULL DEFAULT ''
      )
    `);

    const appliedRows = await queryRows(`SELECT version FROM ${LEDGER_TABLE}`);
    const applied = new Set(appliedRows.map((row) => String(row.version)));

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;

      const startedAt = Date.now();
      if (migration.statements?.length) {
        await runBatch(migration.statements.map((sql) => ({ sql })));
      }

      let note = "";
      if (migration.run) {
        note = (await migration.run({ now: new Date().toISOString() })) ?? "";
      }

      await executeSql(
        `INSERT INTO ${LEDGER_TABLE} (version, description, applied_at, note) VALUES (?, ?, ?, ?)`,
        [migration.version, migration.description, new Date().toISOString(), note],
      );

      logger.info(
        `✅ [UserMigration] ${migration.version} 已应用（${Date.now() - startedAt}ms）${note ? ` ${note}` : ""}`,
      );
    }
  })().catch((error) => {
    migrationPromise = null;
    throw error;
  });

  return migrationPromise;
};

export const getMigrationList = (): Array<{ version: string; description: string }> =>
  MIGRATIONS.map((item) => ({ version: item.version, description: item.description }));
