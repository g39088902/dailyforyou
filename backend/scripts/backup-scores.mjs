#!/usr/bin/env node
/**
 * 迁移前备份脚本
 * 用法：node scripts/backup-scores.mjs
 *
 * - 远程 libSQL：全量导出 news_scores 为 JSON（含行数、md5、建表语句快照）
 * - 本地 node:sqlite：额外用 VACUUM INTO 做一致性快照
 * 只读操作，不会修改任何数据。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "..");

// 手动加载 backend/.env，避免依赖启动 cwd
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

const libsqlUrl = process.env.LIBSQL_URL || "";
const libsqlToken = process.env.LIBSQL_AUTH_TOKEN || "";
const sqlitePath = path.resolve(
  backendRoot,
  process.env.SQLITE_DB_PATH || "./data/scores.sqlite",
);

const outDir = path.join(backendRoot, "data", "backup");
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const normalize = (value) => (typeof value === "bigint" ? Number(value) : value);

const writeBackup = (payload) => {
  const json = JSON.stringify(payload);
  const file = path.join(outDir, `news_scores-${stamp}.json`);
  fs.writeFileSync(file, json);
  console.log(`✅ 备份完成: ${file}`);
  console.log(`   来源: ${payload.kind}`);
  console.log(`   行数: ${payload.count}`);
  console.log(`   md5: ${crypto.createHash("md5").update(json).digest("hex")}`);
};

const backupRemote = async () => {
  const { createClient } = await import("@libsql/client");
  const client = createClient({
    url: libsqlUrl,
    authToken: libsqlToken || undefined,
  });

  const meta = await client.execute(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  const tables = meta.rows.map((row) => ({
    name: String(row.name),
    sql: row.sql === null ? null : String(row.sql),
  }));

  if (!tables.some((t) => t.name === "news_scores")) {
    console.log("ℹ️  远程库中不存在 news_scores 表，无需备份。");
    return;
  }

  const res = await client.execute("SELECT * FROM news_scores");
  const rows = res.rows.map((row) =>
    Object.fromEntries(res.columns.map((col) => [col, normalize(row[col])])),
  );

  writeBackup({
    kind: `remote-libsql (${libsqlUrl})`,
    table: "news_scores",
    exportedAt: new Date().toISOString(),
    count: rows.length,
    tables,
    rows,
  });
};

const backupLocal = async () => {
  if (!fs.existsSync(sqlitePath)) {
    console.log(`ℹ️  本地库不存在（${sqlitePath}），无需备份。`);
    return;
  }

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(sqlitePath);

  const tables = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => ({ name: String(row.name), sql: row.sql === null ? null : String(row.sql) }));

  if (!tables.some((t) => t.name === "news_scores")) {
    console.log("ℹ️  本地库中不存在 news_scores 表，无需备份。");
    db.close();
    return;
  }

  const rows = db
    .prepare("SELECT * FROM news_scores")
    .all()
    .map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, normalize(v)])));

  writeBackup({
    kind: `local-sqlite (${sqlitePath})`,
    table: "news_scores",
    exportedAt: new Date().toISOString(),
    count: rows.length,
    tables,
    rows,
  });

  const snapshot = path.join(outDir, `scores-${stamp}.sqlite`);
  db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
  console.log(`✅ SQLite 一致性快照: ${snapshot}`);

  db.close();
};

try {
  if (libsqlUrl) {
    await backupRemote();
  } else {
    await backupLocal();
  }
} catch (error) {
  console.error("❌ 备份失败:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
