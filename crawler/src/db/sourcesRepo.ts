import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import logger from "../utils/logger.js";
import { executeSql, queryRows, queryOne } from "./client.js";
import {
  SOURCE_REGISTRY,
  resolveLogoDefaults,
  type SourceSeed,
} from "../data/sourceRegistry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTERS_DIR = path.resolve(__dirname, "../routes");

export interface CrawlRunRecord {
  runId: string;
  sourceKey: string;
  startedAt: string;
  finishedAt: string;
  status: "ok" | "empty" | "failed";
  itemsWritten: number;
  error?: string;
}

/**
 * 检查特定 adapter 的路由文件是否存在
 */
export const checkAdapterExists = (adapter: string): boolean => {
  const tsPath = path.join(ROUTERS_DIR, `${adapter}.ts`);
  const jsPath = path.join(ROUTERS_DIR, `${adapter}.js`);
  return fs.existsSync(tsPath) || fs.existsSync(jsPath);
};

/**
 * 迁移执行时直接通过 SOURCE_REGISTRY 初始灌入种子（幂等）
 */
export const seedSourcesFromRegistry = async (): Promise<void> => {
  const now = new Date().toISOString();
  let inserted = 0;

  for (const seed of SOURCE_REGISTRY) {
    const existing = await queryOne("SELECT key FROM sources WHERE key = ?", [seed.key]);
    if (existing) continue;

    const { logoText, logoColor } = resolveLogoDefaults(seed);
    const subType = seed.subType || "";
    const paramsJson = JSON.stringify(seed.params || {});
    const defaultOn = seed.defaultOn !== false ? 1 : 0;
    const enabled = seed.enabled !== undefined ? seed.enabled : 1;
    const retired = seed.retired || 0;

    // items_total 采用子查询直接读取已有历史条数
    await executeSql(
      `INSERT INTO sources (
        key, name, sub_type, params_json, label, category, type, link,
        logo_url, logo_text, logo_color, has_logo, logo_etag,
        sort_order, default_on, enabled, retired,
        status, last_started_at, last_finished_at, last_success_at, last_error,
        items_total, items_last_run, consecutive_failures, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, 0, '',
        ?, ?, ?, ?,
        'idle', '', '', '', '',
        (SELECT COUNT(*) FROM news_items WHERE source_name = ? AND sub_type = ?),
        0, 0, ?
      )`,
      [
        seed.key,
        seed.name,
        subType,
        paramsJson,
        seed.label,
        seed.category || "",
        seed.type || "",
        seed.link || "",
        seed.logoUrl || "",
        logoText,
        logoColor,
        seed.order,
        defaultOn,
        enabled,
        retired,
        seed.name,
        subType,
        now,
      ],
    );
    inserted++;
  }

  logger.info(`🌱 [SourcesRepo] 种子注入完成，新增 ${inserted} 个信源至 sources 表`);
};

/**
 * 启动对账逻辑：在 runCrawlerMigrations() 之后、首轮抓取之前执行
 * - 注册表有、表里没有 -> INSERT
 * - 表里有、注册表没有 -> UPDATE retired = 1（永不物理删除）
 * - 都有 -> UPDATE 元数据（不动 status, last_*, items_* 等运行时字段）
 * - 适配器文件不存在 -> 警告并置 enabled = 0
 * - 异常中止残留的 running 状态 -> 恢复为 failed
 */
export const reconcileSources = async (): Promise<void> => {
  const now = new Date().toISOString();
  logger.info("🔄 [Reconcile] 开始信源清单与适配器一致性对账...");

  // 1. 适配器存在性检查与 enabled 标记调整
  for (const seed of SOURCE_REGISTRY) {
    const hasAdapter = checkAdapterExists(seed.adapter);
    if (!hasAdapter) {
      logger.warn(
        `⚠️ [Reconcile] 注册表声明了 ${seed.key}，但适配器 routes/${seed.adapter}.ts 不存在，置为 disabled`,
      );
      seed.enabled = 0;
    }
  }

  // 2. 查询数据库已有数据
  const dbRows = await queryRows("SELECT key, retired FROM sources");
  const dbMap = new Map<string, { key: string; retired: number }>();
  for (const r of dbRows) {
    dbMap.set(String(r.key), { key: String(r.key), retired: Number(r.retired) });
  }

  const registryKeys = new Set(SOURCE_REGISTRY.map((s) => s.key));

  let insertedCount = 0;
  let updatedMetaCount = 0;
  let retiredCount = 0;

  // 3. 对账与更新
  for (const seed of SOURCE_REGISTRY) {
    const { logoText, logoColor } = resolveLogoDefaults(seed);
    const subType = seed.subType || "";
    const paramsJson = JSON.stringify(seed.params || {});
    const defaultOn = seed.defaultOn !== false ? 1 : 0;
    const enabled = seed.enabled !== undefined ? seed.enabled : 1;
    const retired = seed.retired || 0;

    if (!dbMap.has(seed.key)) {
      // 注册表有，库里没有：INSERT
      await executeSql(
        `INSERT INTO sources (
          key, name, sub_type, params_json, label, category, type, link,
          logo_url, logo_text, logo_color, has_logo, logo_etag,
          sort_order, default_on, enabled, retired,
          status, last_started_at, last_finished_at, last_success_at, last_error,
          items_total, items_last_run, consecutive_failures, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, 0, '',
          ?, ?, ?, ?,
          'idle', '', '', '', '',
          (SELECT COUNT(*) FROM news_items WHERE source_name = ? AND sub_type = ?),
          0, 0, ?
        )`,
        [
          seed.key,
          seed.name,
          subType,
          paramsJson,
          seed.label,
          seed.category || "",
          seed.type || "",
          seed.link || "",
          seed.logoUrl || "",
          logoText,
          logoColor,
          seed.order,
          defaultOn,
          enabled,
          retired,
          seed.name,
          subType,
          now,
        ],
      );
      insertedCount++;
    } else {
      // 库里已有：仅更新元数据，绝不改动运行时状态字段
      await executeSql(
        `UPDATE sources SET
          name = ?,
          sub_type = ?,
          params_json = ?,
          label = ?,
          category = ?,
          type = ?,
          link = ?,
          logo_url = ?,
          logo_text = ?,
          logo_color = ?,
          sort_order = ?,
          default_on = ?,
          enabled = ?,
          retired = ?,
          updated_at = ?
        WHERE key = ?`,
        [
          seed.name,
          subType,
          paramsJson,
          seed.label,
          seed.category || "",
          seed.type || "",
          seed.link || "",
          seed.logoUrl || "",
          logoText,
          logoColor,
          seed.order,
          defaultOn,
          enabled,
          retired,
          now,
          seed.key,
        ],
      );
      updatedMetaCount++;
    }
  }

  // 4. 库里有、注册表没有的标记为 retired = 1
  for (const [dbKey, info] of dbMap.entries()) {
    if (!registryKeys.has(dbKey) && info.retired === 0) {
      await executeSql(
        `UPDATE sources SET retired = 1, updated_at = ? WHERE key = ?`,
        [now, dbKey],
      );
      retiredCount++;
      logger.info(`📦 [Reconcile] 信源 ${dbKey} 已从注册表移除，已置为 retired = 1`);
    }
  }

  // 5. 状态自愈：启动时检查残留的 'running' 状态（防止意外 kill 导致下游永远展示 running）
  const stuckRows = await queryRows(
    "SELECT key FROM sources WHERE status = 'running'",
  );
  if (stuckRows.length > 0) {
    await executeSql(
      `UPDATE sources
       SET status = 'failed',
           last_finished_at = ?,
           last_error = 'Process terminated while running (recovered on startup)',
           updated_at = ?
       WHERE status = 'running'`,
      [now, now],
    );
    logger.warn(
      `⚠️ [Reconcile] 检测到 ${stuckRows.length} 个异常中止残留的 running 信源，已自动重置为 failed: ${stuckRows.map((r: any) => r.key).join(", ")}`,
    );
  }

  logger.info(
    `✅ [Reconcile] 对账完成！新增: ${insertedCount}，更新元数据: ${updatedMetaCount}，下线: ${retiredCount}，现存活跃: ${registryKeys.size}`,
  );
};

/**
 * 标记信源开始抓取
 */
export const updateSourceStatusRunning = async (key: string): Promise<void> => {
  const now = new Date().toISOString();
  await executeSql(
    `UPDATE sources SET status = 'running', last_started_at = ?, updated_at = ? WHERE key = ?`,
    [now, now, key],
  );
};

/**
 * 标记信源抓取成功（written > 0 时为 ok，0 时为 empty）
 * 满足 CR-04: empty 不算成功，不更新 last_success_at
 */
export const updateSourceStatusSuccess = async (
  key: string,
  written: number,
  sourceName: string,
  subType: string,
): Promise<void> => {
  const now = new Date().toISOString();
  const status = written > 0 ? "ok" : "empty";

  await executeSql(
    `UPDATE sources SET
      status = ?,
      last_finished_at = ?,
      last_success_at = CASE WHEN ? > 0 THEN ? ELSE last_success_at END,
      items_last_run = ?,
      items_total = (SELECT COUNT(*) FROM news_items WHERE source_name = ? AND sub_type = ?),
      consecutive_failures = 0,
      last_error = '',
      updated_at = ?
    WHERE key = ?`,
    [status, now, written, now, written, sourceName, subType, now, key],
  );
};

/**
 * 标记信源抓取抛错失败
 */
export const updateSourceStatusFailed = async (
  key: string,
  errorMsg: string,
): Promise<void> => {
  const now = new Date().toISOString();
  await executeSql(
    `UPDATE sources SET
      status = 'failed',
      last_finished_at = ?,
      last_error = ?,
      consecutive_failures = consecutive_failures + 1,
      updated_at = ?
    WHERE key = ?`,
    [now, errorMsg.slice(0, 500), now, key],
  );
};

/**
 * 记录单次抓取历史（保留 7 天）
 */
export const recordCrawlRun = async (record: CrawlRunRecord): Promise<void> => {
  try {
    await executeSql(
      `INSERT INTO crawl_runs (run_id, source_key, started_at, finished_at, status, items_written, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        record.runId,
        record.sourceKey,
        record.startedAt,
        record.finishedAt,
        record.status,
        record.itemsWritten,
        (record.error || "").slice(0, 500),
      ],
    );

    // 清理 7 天前的历史记录
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    await executeSql(`DELETE FROM crawl_runs WHERE started_at < ?`, [sevenDaysAgo]);
  } catch (err) {
    // 审计表写入失败不影响主流程
    logger.warn(`⚠️ [SourcesRepo] 记录 crawl_runs 失败: ${err instanceof Error ? err.message : err}`);
  }
};
