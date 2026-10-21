import { Hono } from "hono";
import { queryNewsBySource } from "../utils/newsDb.js";
import logger from "../utils/logger.js";

export const newsRouter = new Hono();

// 排除作为信源名解析的保留系统路由
// all：/all 已下线，保留在保留字里，避免被 /:source 当成信源返回 200 空数组
const RESERVED_ROUTES = new Set(["auth", "account", "score", "all", "favicon.ico"]);

// 通用信源资讯查询处理器
const handleSourceQuery = async (c: any) => {
  const source = c.req.param("source");
  if (!source || RESERVED_ROUTES.has(source)) {
    return c.notFound();
  }

  const subType = c.req.query("type") || "";
  const limitQuery = c.req.query("limit");
  const limit = limitQuery ? parseInt(limitQuery, 10) : 30;

  try {
    const result = await queryNewsBySource(source, { subType, limit });
    return c.json({
      code: 200,
      ...result,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error(`❌ [GET /${source}] ${msg}`);
    return c.json({ code: 500, message: `读取信源数据失败: ${msg}` }, 500);
  }
};

// 支持 /news/:source 和直接 /:source 两种调用方式
newsRouter.get("/news/:source", handleSourceQuery);
newsRouter.get("/:source", handleSourceQuery);
