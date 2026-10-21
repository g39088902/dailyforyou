import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import logger from "./utils/logger.js";
import { deduplicateArticles } from "./utils/deduplicate.js";
import { persistNewsSafely } from "./db/newsRepo.js";
import type { RouterData } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const routersDirPath = path.join(__dirname, "routes");

export interface CrawlTarget {
  sourceName: string; // 路由文件名前缀，如 cls, jiemian, reuters
  subType?: string;   // 子分类，如 hot, markets, world
  label?: string;     // 中文标签
  params?: Record<string, string>;
}

/** 前端默认订阅频道及其参数配置 */
export const DEFAULT_TARGETS: CrawlTarget[] = [
  { sourceName: "bilibili", label: "哔哩哔哩" },
  { sourceName: "douyin", label: "抖音" },
  { sourceName: "kuaishou", label: "快手" },
  { sourceName: "36kr", label: "36氪" },
  { sourceName: "sspai", label: "少数派" },
  { sourceName: "ithome", label: "IT之家" },
  { sourceName: "thepaper", label: "澎湃新闻" },
  { sourceName: "toutiao", label: "今日头条" },
  { sourceName: "juejin", label: "稀土掘金" },
  { sourceName: "qq-news", label: "腾讯新闻" },
  { sourceName: "cls", label: "财联社电报" },
  { sourceName: "jiemian", label: "界面快报" },
  { sourceName: "jiemian", subType: "hot", label: "界面热门", params: { type: "hot" } },
  { sourceName: "douban-group", label: "豆瓣讨论小组" },
  { sourceName: "ngabbs", label: "NGA" },
  { sourceName: "hellogithub", label: "HelloGitHub" },
  { sourceName: "github", label: "GitHub" },
  { sourceName: "v2ex", label: "V2EX" },
  { sourceName: "hackernews", label: "Hacker News" },
  { sourceName: "reuters", label: "路透社·要闻" },
  { sourceName: "reuters", subType: "world", label: "路透社·国际", params: { type: "world" } },
  { sourceName: "reuters", subType: "business", label: "路透社·商业", params: { type: "business" } },
  { sourceName: "reuters", subType: "technology", label: "路透社·科技", params: { type: "technology" } },
  { sourceName: "reuters", subType: "markets", label: "路透社·金融", params: { type: "markets" } },
  { sourceName: "jin10", subType: "important", label: "金十数据·要闻", params: { type: "important" } },
  { sourceName: "bloomberg", subType: "world", label: "彭博社·全球", params: { type: "world" } },
  { sourceName: "bloomberg", subType: "markets", label: "彭博社·市场", params: { type: "markets" } },
  { sourceName: "sina", label: "新浪网" },
  { sourceName: "weibo", label: "微博热搜" },
  { sourceName: "zhihu", label: "知乎热榜" },
];

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
 * 抓取单个信源目标
 */
export const crawlSingleTarget = async (
  target: CrawlTarget,
): Promise<{ success: boolean; count: number; title: string }> => {
  const { sourceName, subType = "", params = {} } = target;
  const targetLabel = target.label || sourceName;

  try {
    const routeModule = await import(`./routes/${sourceName}.js`);
    if (typeof routeModule.handleRoute !== "function") {
      throw new Error(`Route ${sourceName} does not export handleRoute`);
    }

    const mockCtx = createMockContext(params);
    // 批处理强制拉取最新数据，noCache = true
    const listData: RouterData = await routeModule.handleRoute(mockCtx as any, true);

    if (!Array.isArray(listData?.data)) {
      return { success: false, count: 0, title: targetLabel };
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

    return { success: true, count: written, title };
  } catch (error) {
    logger.error(
      `❌ [CrawlerRunner] 抓取失败 [${targetLabel} (${sourceName}${subType ? `/${subType}` : ""})]: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    );
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
  concurrency?: number;
} = {}): Promise<CrawlSummary> => {
  const startedAt = Date.now();
  const concurrency = Math.max(1, options.concurrency ?? 3);

  let targetsToCrawl: CrawlTarget[] = [];

  if (options.sourceName) {
    const filtered = DEFAULT_TARGETS.filter(
      (t) => t.sourceName.toLowerCase() === options.sourceName?.toLowerCase(),
    );
    if (filtered.length > 0) {
      targetsToCrawl = filtered;
    } else {
      targetsToCrawl = [{ sourceName: options.sourceName }];
    }
  } else {
    // 包含默认频道，并补充其他 routes 目录下尚未包含的源
    const knownNames = new Set(DEFAULT_TARGETS.map((t) => t.sourceName));
    const allRoutes = getAllAvailableRoutes();
    targetsToCrawl = [...DEFAULT_TARGETS];
    for (const r of allRoutes) {
      if (!knownNames.has(r)) {
        targetsToCrawl.push({ sourceName: r });
      }
    }
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
