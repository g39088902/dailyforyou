#!/usr/bin/env node
/**
 * 紧急回滚：把默认账户在新表里的评分/已读状态回灌到旧表 news_scores
 *
 * 用法：node scripts/rollback-user-states.mjs --confirm [--user-id 1]
 *
 * 适用场景：新版上线后需要退回旧版本代码，而旧代码只读 news_scores。
 * 注意：只回灌指定用户（默认 DEFAULT_USER_ID），其他用户数据保留在新表。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "..");
const CONFIRMED = process.argv.includes("--confirm");
const userIdArg = process.argv.indexOf("--user-id");

if (!CONFIRMED) {
  console.error(
    "⚠️ 这是破坏性操作：会用新表数据覆盖旧表 news_scores 中对应 news_hash 的记录。\n" +
      "   确认请追加 --confirm 参数。",
  );
  process.exit(1);
}

const envPath = path.join(backendRoot, ".env");
if (fs.existsSync(envPath)) {
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const matched = /^\s*([\w.-]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!matched) continue;
    let value = matched[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[matched[1]] === undefined) process.env[matched[1]] = value;
  }
}

const userId = userIdArg > -1 ? Number(process.argv[userIdArg + 1]) : Number(process.env.DEFAULT_USER_ID || 1);

const openClient = async () => {
  if (process.env.LIBSQL_URL) {
    const { createClient } = await import("@libsql/client");
    return createClient({
      url: process.env.LIBSQL_URL,
      authToken: process.env.LIBSQL_AUTH_TOKEN || undefined,
    });
  }
  const { DatabaseSync } = await import("node:sqlite");
  const dbPath = path.resolve(backendRoot, process.env.SQLITE_DB_PATH || "./data/scores.sqlite");
  return new DatabaseSync(dbPath);
};

const run = async () => {
  const client = await openClient();
  const query = async (sql, args = []) => {
    if (typeof client.execute === "function") {
      const res = await client.execute({ sql, args });
      return res.rows || [];
    }
    return client.prepare(sql).all(...args);
  };
  const exec = async (sql, args = []) => {
    if (typeof client.execute === "function") {
      await client.execute({ sql, args });
      return;
    }
    client.prepare(sql).run(...args);
  };

  const legacyTable = await query(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'news_scores'`,
  );
  if (legacyTable.length === 0) {
    console.error("❌ 旧表 news_scores 不存在，无需回滚。");
    process.exit(1);
  }

  const rows = await query(
    `SELECT * FROM user_news_states WHERE user_id = ?`,
    [userId],
  );

  console.log(`准备回灌 ${rows.length} 条记录（user_id=${userId}）...`);

  let updated = 0;
  for (const row of rows) {
    await exec(
      `UPDATE news_scores
       SET ai_score = ?, ai_layer = ?, ai_reason = ?, ai_model = ?,
           user_score = ?, user_layer = ?, user_reason = ?, is_user_modified = ?, user_updated_at = ?,
           is_read = ?, read_at = ?, updated_at = ?
       WHERE news_hash = ?`,
      [
        Number(row.ai_score ?? -1),
        String(row.ai_layer || "Uncertain"),
        String(row.ai_reason || ""),
        String(row.ai_model || ""),
        row.user_score ?? null,
        row.user_layer ?? null,
        row.user_reason ?? null,
        Number(row.is_user_modified || 0),
        row.user_updated_at ?? null,
        Number(row.is_read || 0),
        row.read_at ?? null,
        String(row.updated_at || new Date().toISOString()),
        String(row.news_hash),
      ],
    );
    updated += 1;
  }

  console.log(`✅ 已回灌 ${updated} 条到 news_scores。`);
};

run().catch((error) => {
  console.error("❌ 回滚失败:", error);
  process.exit(1);
});
