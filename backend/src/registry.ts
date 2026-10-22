import { config } from "./config.js";
import { Hono } from "hono";
import {
  scoreNewsItem,
  scoreNewsBatch,
  lookupCachedScoresBatch,
  formatNewsInput,
  extractNewsMetadata,
  updateManualScoreItem,
  updateNewsReadStatusItem,
} from "./utils/scorer.js";
import type {
  ScoreInputItem,
  ManualScoreInput,
  ReadStatusInput,
  ScoreRunContext,
} from "./utils/scorer.js";
import {
  getScoreRecordByHash,
  getScoreRecordById,
  queryScoreRecords,
  getAllReadNewsHashes,
  rowToScoreResult,
} from "./utils/scoreDb.js";
import { getPromptContext } from "./utils/promptDb.js";
import { consumeRateLimit } from "./utils/rateLimit.js";
import { requireAuth, type AuthEnv } from "./auth/middleware.js";
import { authRouter } from "./auth/index.js";
import { accountRouter } from "./api/account.js";
import { newsRouter } from "./routes/news.js";
import logger from "./utils/logger.js";

const app = new Hono<AuthEnv>();

/** 从鉴权中间件注入的上下文读取当前用户 */
const getAuthUser = (c: any): { userId: number } => c.get("authUser") as { userId: number };

/** 组装评分上下文：用户 ID + 该用户当前的 Prompt 与指纹 */
const buildScoreContext = async (c: any): Promise<ScoreRunContext> => {
  const { userId } = getAuthUser(c);
  const prompt = await getPromptContext(userId);
  return { userId, promptText: prompt.prompt, promptHash: prompt.promptHash };
};

/** 评分接口的按用户限流（缓存查询不计入，仅约束评分主链路） */
const scoreRateGuard = (c: any, userId: number) => {
  const result = consumeRateLimit(`score:${userId}`, config.SCORE_RATE_LIMIT_PER_MIN);
  if (result.allowed) return null;
  return c.json(
    {
      code: 429,
      message: "评分请求过于频繁，请稍后再试",
      retryAfter: result.retryAfterSeconds,
    },
    429,
  );
};

// ⚠️ 顺序敏感：必须在下方所有 /score 路由注册之前（Hono 的中间件只对之后注册的路由生效）
app.use("/score", requireAuth);
app.use("/score/*", requireAuth);

// 铁律②唯一豁免：鉴权与账户路由不是热榜信源，不能放进 src/routes（会被目录扫描器接管并 405）
app.route("/auth", authRouter);
app.route("/account", accountRouter);

// 个性化新闻喜好度评分接口（GET 单条评分，优先检查 SQLite 缓存）
app.get("/score", async (c) => {
  try {
    const { userId } = getAuthUser(c);
    const limited = scoreRateGuard(c, userId);
    if (limited) return limited;

    const forceRescore =
      c.req.query("force") === "true" || c.req.query("rescore") === "true";
    const input: ScoreInputItem = {
      title: c.req.query("title"),
      desc: c.req.query("desc"),
      source: c.req.query("source"),
      url: c.req.query("url"),
      text: c.req.query("text"),
      content: c.req.query("content"),
      news: c.req.query("news"),
    };

    if (!formatNewsInput(input)) {
      return c.json(
        {
          code: 400,
          message: "请提供待评分新闻内容（支持 title、desc、text、content 或 news 参数）",
        },
        400,
      );
    }

    const ctx = await buildScoreContext(c);
    const result = await scoreNewsItem(input, ctx, { forceRescore });
    return c.json({
      code: 200,
      message: "评分成功",
      data: result,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    logger.error(`❌ [GET /score] ${msg}`);
    return c.json({ code: 500, message: `评分失败: ${msg}` }, 500);
  }
});

// 个性化新闻喜好度评分接口（POST 支持单条或批量评分与降序排列，优先检查 SQLite 缓存）
app.post("/score", async (c) => {
  try {
    const { userId } = getAuthUser(c);
    const limited = scoreRateGuard(c, userId);
    if (limited) return limited;

    let body: any;
    const contentType = c.req.header("content-type") || "";
    if (contentType.includes("application/json")) {
      body = await c.req.json();
    } else {
      const rawText = await c.req.text();
      try {
        body = JSON.parse(rawText);
      } catch {
        body = { text: rawText };
      }
    }

    const queryForceRescore =
      c.req.query("force") === "true" || c.req.query("rescore") === "true";
    const querySort = c.req.query("sort") === "true";

    // 判断是否为批量评分请求
    const batchItems: Array<string | ScoreInputItem> | null = Array.isArray(body)
      ? body
      : Array.isArray(body?.items)
        ? body.items
        : Array.isArray(body?.texts)
          ? body.texts
          : Array.isArray(body?.data)
            ? body.data
            : null;

    if (batchItems !== null) {
      const ctx = await buildScoreContext(c);
      const cacheOnly = c.req.query("cacheOnly") === "true" || body?.cacheOnly === true;
      if (cacheOnly) {
        const cachedList = await lookupCachedScoresBatch(userId, batchItems, ctx.promptHash);
        return c.json({
          code: 200,
          message: "缓存查询成功",
          total: cachedList.length,
          data: cachedList,
        });
      }

      const forceRescore =
        queryForceRescore || body?.force === true || body?.rescore === true || body?.forceRescore === true;
      const shouldSort = querySort || body?.sort === true;
      const concurrency = typeof body?.concurrency === "number" ? body.concurrency : undefined;

      const scoredList = await scoreNewsBatch(batchItems, ctx, { forceRescore, concurrency });
      if (shouldSort) {
        scoredList.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      }

      return c.json({
        code: 200,
        message: "评分成功",
        total: scoredList.length,
        data: scoredList,
      });
    }

    // 单条评分请求
    const forceRescore =
      queryForceRescore || body?.force === true || body?.rescore === true || body?.forceRescore === true;
    const input = typeof body === "string" ? body : (body as ScoreInputItem);

    if (!formatNewsInput(input)) {
      return c.json(
        {
          code: 400,
          message: "请提供待评分新闻内容（支持单条 { title, desc, text } 或批量 { items: [...] }）",
        },
        400,
      );
    }

    const result = await scoreNewsItem(input, await buildScoreContext(c), { forceRescore });
    return c.json({
      code: 200,
      message: "评分成功",
      data: result,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    logger.error(`❌ [POST /score] ${msg}`);
    return c.json({ code: 500, message: `评分失败: ${msg}` }, 500);
  }
});

// 批量仅查询 SQLite 本地缓存评分接口（毫秒级返回，不触发 AI 调用）
app.post("/score/cache", async (c) => {
  try {
    let body: any = {};
    const contentType = c.req.header("content-type") || "";
    if (contentType.includes("application/json")) {
      body = await c.req.json();
    } else {
      const rawText = await c.req.text();
      if (rawText.trim()) {
        body = JSON.parse(rawText);
      }
    }

    const batchItems: Array<string | ScoreInputItem> = Array.isArray(body)
      ? body
      : Array.isArray(body?.items)
        ? body.items
        : Array.isArray(body?.data)
          ? body.data
          : [];

    const ctx = await buildScoreContext(c);
    const cachedList = await lookupCachedScoresBatch(ctx.userId, batchItems, ctx.promptHash);
    return c.json({
      code: 200,
      message: "缓存查询成功",
      total: cachedList.length,
      data: cachedList,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    logger.error(`❌ [POST /score/cache] ${msg}`);
    return c.json({ code: 500, message: `查询缓存评分失败: ${msg}` }, 500);
  }
});


// 接收用户手动修正分数的通用处理器（支持单条或批量修正、支持重置，供将来 AI 自动调整推荐逻辑使用）
const handleManualScoreUpdate = async (c: any) => {
  try {
    let body: any = {};
    const contentType = c.req.header("content-type") || "";
    if (contentType.includes("application/json")) {
      body = await c.req.json();
    } else {
      const rawText = await c.req.text();
      if (rawText.trim()) {
        body = JSON.parse(rawText);
      }
    }

    const batchItems: ManualScoreInput[] | null = Array.isArray(body)
      ? body
      : Array.isArray(body?.items)
        ? body.items
        : Array.isArray(body?.data)
          ? body.data
          : null;

    const { userId } = getAuthUser(c);

    if (batchItems !== null) {
      const results = await Promise.all(
        batchItems.map((item) => updateManualScoreItem(userId, item)),
      );
      return c.json({
        code: 200,
        message: "批量用户评分修正已保存",
        total: results.length,
        data: results,
      });
    }

    const result = await updateManualScoreItem(userId, body as ManualScoreInput);
    return c.json({
      code: 200,
      message: result.isUserModified ? "用户评分修正已保存" : "已重置为 AI 原始评分",
      data: result,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    logger.error(`❌ [Manual Score Update] ${msg}`);
    return c.json({ code: 400, message: `保存手动评分失败: ${msg}` }, 400);
  }
};

// 注册用户手动修正评分接口（支持 POST / PUT / PATCH / DELETE 多种调用方式）
app.post("/score/manual", handleManualScoreUpdate);
app.put("/score/manual", handleManualScoreUpdate);
app.patch("/score/manual", handleManualScoreUpdate);
app.delete("/score/manual", async (c) => {
  try {
    const { userId } = getAuthUser(c);
    const idParam = c.req.query("id");
    const hashParam = c.req.query("newsHash") || c.req.query("hash");
    let recordId = idParam && /^\d+$/.test(idParam) ? parseInt(idParam, 10) : undefined;
    let newsHash = hashParam ? hashParam.trim() : undefined;

    if (!recordId && !newsHash) {
      const body = await c.req.json().catch(() => ({}));
      if (body.id) recordId = typeof body.id === "number" ? body.id : parseInt(body.id, 10);
      if (body.newsHash) newsHash = String(body.newsHash).trim();
    }

    if (!recordId && !newsHash) {
      return c.json({ code: 400, message: "请提供待重置记录的 id 或 newsHash" }, 400);
    }

    const result = await updateManualScoreItem(userId, {
      id: recordId,
      newsHash,
      reset: true,
    });

    return c.json({
      code: 200,
      message: "已重置为 AI 原始评分",
      data: result,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    logger.error(`❌ [DELETE /score/manual] ${msg}`);
    return c.json({ code: 500, message: `重置失败: ${msg}` }, 500);
  }
});
app.post("/score/feedback", handleManualScoreUpdate);
app.put("/score", handleManualScoreUpdate);
app.patch("/score", handleManualScoreUpdate);

// 接收新闻已读状态标记的通用处理器（支持单条或批量标记已读/未读）
const handleNewsReadStatusUpdate = async (c: any) => {
  try {
    let body: any = {};
    const contentType = c.req.header("content-type") || "";
    if (contentType.includes("application/json")) {
      body = await c.req.json();
    } else {
      const rawText = await c.req.text();
      if (rawText.trim()) {
        body = JSON.parse(rawText);
      }
    }

    const batchItems: ReadStatusInput[] | null = Array.isArray(body)
      ? body
      : Array.isArray(body?.items)
        ? body.items
        : Array.isArray(body?.data)
          ? body.data
          : null;

    if (batchItems !== null) {
      const { userId } = getAuthUser(c);
      const defaultIsRead = typeof body?.isRead === "boolean" ? body.isRead : true;
      const results: any[] = [];
      for (const item of batchItems) {
        try {
          const payloadItem =
            typeof item === "string"
              ? { newsHash: item, isRead: defaultIsRead }
              : {
                  ...item,
                  isRead: item.isRead !== undefined ? item.isRead : defaultIsRead,
                };
          results.push(await updateNewsReadStatusItem(userId, payloadItem));
        } catch {
          // 忽略单条缺少内容的异常，保证批量顺畅完成
        }
      }
      return c.json({
        code: 200,
        message: "批量已读状态已保存",
        total: results.length,
        data: results,
      });
    }

    const result = await updateNewsReadStatusItem(getAuthUser(c).userId, body as ReadStatusInput);
    return c.json({
      code: 200,
      message: result.isRead ? "已标记为已读" : "已标记为未读",
      data: result,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    logger.error(`❌ [Read Status Update] ${msg}`);
    return c.json({ code: 400, message: `更新已读状态失败: ${msg}` }, 400);
  }
};

app.post("/score/read", handleNewsReadStatusUpdate);
app.put("/score/read", handleNewsReadStatusUpdate);
app.patch("/score/read", handleNewsReadStatusUpdate);

// 查询全部已读新闻哈希集合（供前端跨端同步与快速过滤）
app.get("/score/read", async (c) => {
  try {
    const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : 5000;
    const hashes = await getAllReadNewsHashes(getAuthUser(c).userId, limit);
    return c.json({
      code: 200,
      total: hashes.length,
      hashes,
      data: hashes,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    logger.error(`❌ [GET /score/read] ${msg}`);
    return c.json({ code: 500, message: `查询已读记录失败: ${msg}` }, 500);
  }
});

// 查询数据库中存储的新闻打分与用户修正记录接口（供将来 AI 自动调整推荐逻辑或后台分析调用）
const handleQueryScoreRecords = (defaultOnlyModified: boolean) => async (c: any) => {
  try {
    const { userId } = getAuthUser(c);
    const idParam = c.req.query("id");
    const hashParam = c.req.query("newsHash") || c.req.query("hash");

    if (idParam && /^\d+$/.test(idParam)) {
      const row = await getScoreRecordById(userId, parseInt(idParam, 10));
      if (!row) {
        return c.json({ code: 404, message: "未找到对应的评分记录" }, 404);
      }
      return c.json({
        code: 200,
        data: {
          ...rowToScoreResult(row, true),
          source: row.source,
          title: row.title,
          url: row.url,
          aiModel: row.ai_model,
        },
      });
    }

    if (hashParam) {
      const row = await getScoreRecordByHash(userId, hashParam.trim());
      if (!row) {
        return c.json({ code: 404, message: "未找到对应的评分记录" }, 404);
      }
      return c.json({
        code: 200,
        data: {
          ...rowToScoreResult(row, true),
          source: row.source,
          title: row.title,
          url: row.url,
          aiModel: row.ai_model,
        },
      });
    }

    const modifiedQuery = c.req.query("modified");
    const onlyUserModified =
      modifiedQuery !== undefined
        ? modifiedQuery === "true" || modifiedQuery === "1"
        : defaultOnlyModified;

    const readQuery = c.req.query("read") ?? c.req.query("isRead");
    const onlyRead =
      readQuery !== undefined
        ? readQuery === "true" || readQuery === "1"
        : undefined;

    const source = c.req.query("source") || undefined;
    const keyword = c.req.query("keyword") || c.req.query("q") || undefined;

    const pageParam = c.req.query("page");
    const pageSizeParam = c.req.query("pageSize");
    const page = pageParam ? Math.max(1, parseInt(pageParam, 10)) : undefined;
    const pageSize = pageSizeParam
      ? Math.max(1, Math.min(parseInt(pageSizeParam, 10), 200))
      : undefined;

    const limit =
      pageSize ??
      (c.req.query("limit") ? Math.max(1, Math.min(parseInt(c.req.query("limit")!, 10), 500)) : 20);
    const offset =
      page && pageSize
        ? (page - 1) * pageSize
        : (c.req.query("offset") ? Math.max(0, parseInt(c.req.query("offset")!, 10)) : 0);

    const { total, items } = await queryScoreRecords(userId, {
      onlyUserModified,
      onlyRead,
      source,
      keyword,
      limit,
      offset,
    });

    const formattedItems = items.map((row) => ({
      ...rowToScoreResult(row, true),
      source: row.source,
      title: row.title,
      url: row.url,
      aiModel: row.ai_model,
    }));

    const currentPage = page || (limit > 0 ? Math.floor(offset / limit) + 1 : 1);

    return c.json({
      code: 200,
      total,
      page: currentPage,
      pageSize: limit,
      count: formattedItems.length,
      onlyUserModified,
      data: formattedItems,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    logger.error(`❌ [GET /score/records] ${msg}`);
    return c.json({ code: 500, message: `查询评分记录失败: ${msg}` }, 500);
  }
};

app.get("/score/records", handleQueryScoreRecords(false));
app.get("/score/manual", handleQueryScoreRecords(true));
app.get("/score/feedback", handleQueryScoreRecords(true));

// 挂载数据库新闻供给路由（/:source, /news/:source）
app.route("/", newsRouter);

export default app;
