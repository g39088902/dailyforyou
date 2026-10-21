import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import logger from "./utils/logger.js";
import { deduplicateArticles } from "./utils/deduplicate.js";
import { persistNewsSafely } from "./db/newsRepo.js";
import {
  SOURCE_REGISTRY,
  type SourceSeed,
} from "./data/sourceRegistry.js";
import {
  updateSourceStatusRunning,
  updateSourceStatusSuccess,
  updateSourceStatusFailed,
  recordCrawlRun,
  checkAdapterExists,
} from "./db/sourcesRepo.js";
import type { RouterData } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const routersDirPath = path.join(__dirname, "routes");

/** 获取所有可用的 route 文件名称列表 */
export const getAllAvailableRoutes = (): string[] => {
  if (!fs.existsSync(routersDirPath) || !fs.statSync(routersDirPath).isDirectory()) {
    return [];
  }
  return fs
    .readdirSync(routersDirPath)
    .filter((f) => (f.endsWith(".ts") || f.endsWith(".js")) && !f.endsWith(".d.ts"))
    .map((f) => f.replace(/\.(ts|js)$/, ""));
};

/** 构造模拟的 Hono Context，满足 route 适配器对 query 参数的读取 */
const createMockContext = (params: Record<string, string> = {}) => {
  return {
    req: {
      query: (key?: string) => {
        if (!key) return params;
        return params[key] ?? "";
      },
      header: () => "",
    },
  };
};

/**
 * 抓取单个信源目标（严格执行心跳协议）
 */
export const crawlSingleTarget = async (
  target: SourceSeed,
): Promise<{ success: boolean; count: number; title: string }> => {
  const { key, name: sourceName, subType = "", params = {}, adapter } = target;
  const targetLabel = target.label || key;
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();

  // ① 心跳协议：标记 status='running'
  await updateSourceStatusRunning(key);

  if (!checkAdapterExists(adapter)) {
    const errorMsg = `Adapter file routes/${adapter}.ts not found`;
    logger.warn(`⚠️ [CrawlerRunner] 适配器不存在 [${targetLabel} (${key})]: ${errorMsg}`);
    await updateSourceStatusFailed(key, errorMsg);
    await recordCrawlRun({
      runId,
      sourceKey: key,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "failed",
      itemsWritten: 0,
      error: errorMsg,
    });
    return { success: false, count: 0, title: targetLabel };
  }

  try {
    const routeModule = await import(`./routes/${adapter}.js`);
    if (typeof routeModule.handleRoute !== "function") {
      throw new Error(`Route adapter ${adapter} does not export handleRoute`);
    }

    const mockCtx = createMockContext(params);
    // 批处理强制拉取最新数据，noCache = true
    const listData: RouterData = await routeModule.handleRoute(mockCtx as any, true);

    if (!Array.isArray(listData?.data)) {
      throw new Error(`Invalid data returned by route ${adapter}: data is not an array`);
    }

    const routeKey = subType ? `${sourceName}?type=${subType}` : sourceName;
    const deduplicated = deduplicateArticles(listData.data, routeKey, {
      noCache: true,
      maxItems: 30,
    });

    const title = listData.title || targetLabel;
    const written = await persistNewsSafely(title, deduplicated, {
      sourceName,
      subType,
    });

    const finishedAt = new Date().toISOString();
    // ③ 心跳协议：成功分支，written > 0 为 ok，0 为 empty
    await updateSourceStatusSuccess(key, written, sourceName, subType);
    await recordCrawlRun({
      runId,
      sourceKey: key,
      startedAt,
      finishedAt,
      status: written > 0 ? "ok" : "empty",
      itemsWritten: written,
    });

    return { success: true, count: written, title };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    const finishedAt = new Date().toISOString();

    logger.error(
      `❌ [CrawlerRunner] 抓取失败 [${targetLabel} (${sourceName}${subType ? `/${subType}` : ""})]: ${errorMsg}`,
    );

    // ④ 心跳协议：异常分支，标记 failed
    await updateSourceStatusFailed(key, errorMsg);
    await recordCrawlRun({
      runId,
      sourceKey: key,
      startedAt,
      finishedAt,
      status: "failed",
      itemsWritten: 0,
      error: errorMsg,
    });

    return { success: false, count: 0, title: targetLabel };
  }
};

export interface CrawlSummary {
  totalTargets: number;
  successTargets: number;
  failedTargets: number;
  totalPersisted: number;
  durationMs: number;
}

/**
 * 执行全量或指定信源抓取任务
 */
export const runCrawlTask = async (options: {
  sourceName?: string;
  key?: string;
  concurrency?: number;
} = {}): Promise<CrawlSummary> => {
  const startedAt = Date.now();
  const concurrency = Math.max(1, options.concurrency ?? 3);

  let targetsToCrawl: SourceSeed[] = [];

  if (options.key) {
    targetsToCrawl = SOURCE_REGISTRY.filter((s) => s.key === options.key);
  } else if (options.sourceName) {
    const sName = options.sourceName.toLowerCase();
    // 匹配 key、name 或 adapter
    const filtered = SOURCE_REGISTRY.filter(
      (s) =>
        s.key.toLowerCase() === sName ||
        s.name.toLowerCase() === sName ||
        s.adapter.toLowerCase() === sName,
    );
    if (filtered.length > 0) {
      targetsToCrawl = filtered;
    } else {
      // 兼容直接抓取未登记但在 routes 目录下存在的实验性适配器
      targetsToCrawl = [
        {
          key: options.sourceName,
          name: options.sourceName,
          adapter: options.sourceName,
          label: options.sourceName,
          order: 999,
          defaultOn: false,
        },
      ];
    }
  } else {
    // 全量抓取仅针对未禁用、未退役的已登记信源
    targetsToCrawl = SOURCE_REGISTRY.filter((s) => s.enabled !== 0 && s.retired !== 1);
  }

  logger.info(`🚀 [CrawlerRunner] 开始抓取，共 ${targetsToCrawl.length} 个目标，并发度 ${concurrency}...`);

  let successTargets = 0;
  let failedTargets = 0;
  let totalPersisted = 0;

  // 并发池调度
  let cursor = 0;
  const worker = async () => {
    while (cursor < targetsToCrawl.length) {
      const idx = cursor++;
      const target = targetsToCrawl[idx];
      const res = await crawlSingleTarget(target);
      if (res.success) {
        successTargets++;
        totalPersisted += res.count;
      } else {
        failedTargets++;
      }
    }
  };

  const pool = Array.from({ length: Math.min(concurrency, targetsToCrawl.length) }, () => worker());
  await Promise.all(pool);

  const durationMs = Date.now() - startedAt;
  logger.info(
    `🏁 [CrawlerRunner] 抓取完成！成功: ${successTargets}/${targetsToCrawl.length}，入库/更新: ${totalPersisted} 条，耗时 ${(
      durationMs / 1000
    ).toFixed(1)}s`,
  );

  return {
    totalTargets: targetsToCrawl.length,
    successTargets,
    failedTargets,
    totalPersisted,
    durationMs,
  };
};
