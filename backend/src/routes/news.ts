import { Hono } from "hono";
import {
  queryNewsBySource,
  getSourcesManifest,
  resolveSourceLogo,
  getHealthStatus,
  UnknownSourceError,
} from "../utils/newsDb.js";
import logger from "../utils/logger.js";

export const newsRouter = new Hono();

// 排除作为信源名解析的保留系统路由
const RESERVED_ROUTES = new Set([
  "auth",
  "account",
  "score",
  "sources",
  "logo",
  "health",
  "all",
  "favicon.ico",
]);

/**
 * GET /sources — 动态信源清单 + 实时健康状态
 */
newsRouter.get("/sources", async (c) => {
  try {
    const manifest = await getSourcesManifest();
    const ifNoneMatch = c.req.header("if-none-match");

    if (
      manifest.initialized &&
      ifNoneMatch &&
      ifNoneMatch.replace(/"/g, "").trim() === manifest.etag
    ) {
      return c.body(null, 304, {
        ETag: manifest.etag,
        "Cache-Control": "public, max-age=60",
      });
    }

    c.header("ETag", manifest.etag);
    c.header("Cache-Control", "public, max-age=60");
    return c.json({
      code: 200,
      ...manifest,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error(`❌ [GET /sources] ${msg}`);
    return c.json({ code: 500, message: `读取信源清单失败: ${msg}` }, 500);
  }
});

/**
 * GET /logo/:file — 永远有图的信源图标（三级降级：外链 302 -> 数据库 BLOB -> 动态 SVG 徽标）
 */
newsRouter.get("/logo/:file", async (c) => {
  const file = c.req.param("file") || "";
  const key = file.replace(/\.[a-zA-Z0-9]+$/, "").trim();
  if (!key) {
    return c.json({ code: 404, message: "invalid logo key" }, 404);
  }

  try {
    const res = await resolveSourceLogo(key);
    if (res.type === "not_found") {
      return c.json({ code: 404, message: "unknown source" }, 404);
    }

    const ifNoneMatch = c.req.header("if-none-match");
    if (ifNoneMatch && ifNoneMatch.replace(/"/g, "").trim() === res.etag) {
      return c.body(null, 304, {
        ETag: res.etag,
        "Cache-Control": "public, max-age=604800",
      });
    }

    if (res.type === "redirect") {
      c.header("ETag", res.etag);
      c.header("Cache-Control", "public, max-age=604800");
      c.header("X-Logo-Source", "url");
      return c.redirect(res.url, 302);
    }

    if (res.type === "blob") {
      return new Response(new Uint8Array(res.bytes), {
        status: 200,
        headers: {
          "Content-Type": res.mime,
          ETag: res.etag,
          "Cache-Control": "public, max-age=604800",
          "X-Logo-Source": "blob",
        },
      });
    }

    // res.type === "badge"
    return new Response(res.svg, {
      status: 200,
      headers: {
        "Content-Type": res.mime,
        ETag: res.etag,
        "Cache-Control": "public, max-age=604800",
        "X-Logo-Source": "badge",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error(`❌ [GET /logo/${file}] ${msg}`);
    return c.json({ code: 500, message: `读取信源图标失败: ${msg}` }, 500);
  }
});

/**
 * GET /health — 数据库、信源新鲜度与爬虫心跳健康检查
 */
newsRouter.get("/health", async (c) => {
  try {
    const health = await getHealthStatus();
    return c.json(health);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error(`❌ [GET /health] ${msg}`);
    return c.json(
      {
        code: 500,
        status: "down",
        message: msg,
      },
      500,
    );
  }
});

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
    if (err instanceof UnknownSourceError) {
      return c.json({ code: 404, message: "unknown source" }, 404);
    }
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error(`❌ [GET /${source}] ${msg}`);
    return c.json({ code: 500, message: `读取信源数据失败: ${msg}` }, 500);
  }
};

// 支持 /news/:source 和直接 /:source 两种调用方式
newsRouter.get("/news/:source", handleSourceQuery);
newsRouter.get("/:source", handleSourceQuery);
