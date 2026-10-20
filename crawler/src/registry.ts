import { fileURLToPath } from "url";
import { config } from "./config.js";
import { Hono } from "hono";
import getRSS from "./utils/getRSS.js";
import { deduplicateArticles } from "./utils/deduplicate.js";
import { persistNewsSafely } from "./db/newsRepo.js";
import logger from "./utils/logger.js";
import path from "path";
import fs from "fs";

const app = new Hono();

// 模拟 __dirname
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 路由数据
let allRoutePath: Array<string> = [];
const routersDirName: string = "routes";

// 排除路由
const excludeRoutes: Array<string> = [];

// 建立完整目录路径
const routersDirPath = path.join(__dirname, routersDirName);

// 递归查找函数
const findTsFiles = (dirPath: string, allFiles: string[] = [], basePath: string = ""): string[] => {
  // 读取目录下的所有文件和文件夹
  const items: Array<string> = fs.readdirSync(dirPath);
  // 遍历每个文件或文件夹
  items.forEach((item) => {
    const fullPath: string = path.join(dirPath, item);
    const relativePath: string = basePath ? path.posix.join(basePath, item) : item;
    const stat: fs.Stats = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      // 如果是文件夹，递归查找
      findTsFiles(fullPath, allFiles, relativePath);
    } else if (
      stat.isFile() &&
      (item.endsWith(".ts") || item.endsWith(".js")) &&
      !item.endsWith(".d.ts")
    ) {
      // 符合条件
      allFiles.push(relativePath.replace(/\.(ts|js)$/, ""));
    }
  });
  return allFiles;
};

// 获取全部路由
if (fs.existsSync(routersDirPath) && fs.statSync(routersDirPath).isDirectory()) {
  allRoutePath = findTsFiles(routersDirPath);
} else {
  console.error(`📂 The directory ${routersDirPath} does not exist or is not a directory`);
}

// 注册全部信源路由
for (let index = 0; index < allRoutePath.length; index++) {
  const router = allRoutePath[index];
  // 是否处于排除名单
  if (excludeRoutes.includes(router)) {
    continue;
  }
  const listApp = app.basePath(`/${router}`);
  // 返回榜单
  listApp.get("/", async (c) => {
    // 是否采用缓存
    const noCache = c.req.query("cache") === "false";
    // 限制显示条目
    const limit = c.req.query("limit");
    // 是否输出 RSS
    const rssEnabled = c.req.query("rss") === "true";
    // 获取路由路径
    const { handleRoute } = await import(`./routes/${router}.js`);
    const listData = await handleRoute(c, noCache);
    // 限制单信源最多只返回 30 条（如果传了更小的 limit 则以更小的为准）
    const maxLimit = limit ? Math.min(parseInt(limit, 10), 30) : 30;
    if (Array.isArray(listData?.data)) {
      // 构造当前路由及子分类唯一标识（忽略 cache / limit / rss 等控制参数）
      const rawQueries = c.req.query();
      const subQuery = Object.keys(rawQueries)
        .filter((k) => !["cache", "limit", "rss"].includes(k) && rawQueries[k] !== undefined)
        .sort()
        .map((k) => `${k}=${rawQueries[k]}`)
        .join("&");
      const routeKey = subQuery ? `${router}?${subQuery}` : router;

      listData.data = deduplicateArticles(listData.data, routeKey, {
        noCache,
        maxItems: maxLimit,
      });
      listData.total = listData.data.length;

      // 新抓取（非缓存命中）的条目写入新闻库；翻译已由适配器在抓取阶段完成
      if (!listData.fromCache && config.NEWS_PERSIST_ENABLED) {
        await persistNewsSafely(listData.title || router, listData.data);
      }
    }
    // 是否输出 RSS
    if (rssEnabled || config.RSS_MODE) {
      const rss = getRSS(listData);
      if (typeof rss === "string") {
        c.header("Content-Type", "application/xml; charset=utf-8");
        return c.body(rss);
      } else {
        return c.json({ code: 500, message: "RSS generation failed" }, 500);
      }
    }
    return c.json({ code: 200, ...listData });
  });
  // 请求方式错误
  listApp.all("*", (c) => c.json({ code: 405, message: "Method Not Allowed" }, 405));
}

// 获取全部路由
app.get("/all", (c) =>
  c.json(
    {
      code: 200,
      count: allRoutePath.length,
      routes: allRoutePath.map((route) => {
        // 是否处于排除名单
        if (excludeRoutes.includes(route)) {
          return {
            name: route,
            path: undefined,
            message: "This interface is temporarily offline",
          };
        }
        return { name: route, path: `/${route}` };
      }),
    },
    200,
  ),
);

logger.info(`🕷️ [Crawler] 已注册 ${allRoutePath.length} 个信源路由`);

export default app;
