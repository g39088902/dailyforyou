import axios from "axios";
import crypto from "crypto";
import { config } from "../config.js";
import logger from "./logger.js";
import {
  getScoreRecordByHash,
  getScoreRecordsByHashes,
  saveAiScoreRecord,
  saveUserManualScore,
  saveNewsReadStatus,
  rowToScoreResult,
  type SaveUserManualScoreParams,
  type SaveNewsReadStatusParams,
  type NewsScoreRow,
} from "./scoreDb.js";
import type { ScoreResult } from "../types.js";
import { buildScoreMessages } from "./scorePrompt.js";

export interface ScoreInputItem {
  id?: string | number;
  newsHash?: string;
  title?: string;
  desc?: string;
  text?: string;
  content?: string;
  news?: string;
  source?: string;
  url?: string;
  mobileUrl?: string;
  [key: string]: unknown;
}

/**
 * 一次评分运行所需的用户上下文（prompt 与指纹由路由层统一解析，避免逐条查库）
 */
export interface ScoreRunContext {
  userId: number;
  promptText: string;
  promptHash: string;
}

export interface ScoreOptions {
  forceRescore?: boolean;
  concurrency?: number;
}

/**
 * 计算规范化新闻文本的唯一哈希（用于唯一索引与缓存键）
 */
export const hashNewsText = (text: string): string => {
  return crypto.createHash("md5").update(text).digest("hex");
};

/**
 * 去除简单 HTML 标签并清理多余空白
 */
const cleanHtml = (input: string): string => {
  return input
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

export interface ExtractedNewsMeta {
  source: string;
  title: string;
  desc: string;
  url: string;
  formattedText: string;
  newsHash: string;
}

/**
 * 从输入字符串或新闻对象提取标准化元数据与待评分文本
 */
export const extractNewsMetadata = (item: string | ScoreInputItem): ExtractedNewsMeta => {
  if (typeof item === "string") {
    const formattedText = cleanHtml(item);
    return {
      source: "",
      title: formattedText.slice(0, 120),
      desc: "",
      url: "",
      formattedText,
      newsHash: formattedText ? hashNewsText(formattedText) : "",
    };
  }

  if (!item || typeof item !== "object") {
    return {
      source: "",
      title: "",
      desc: "",
      url: "",
      formattedText: "",
      newsHash: "",
    };
  }

  const rawDesc = typeof item.desc === "string" ? item.desc.slice(0, 500) : "";
  const title = typeof item.title === "string" ? cleanHtml(item.title) : "";
  const desc = rawDesc ? cleanHtml(rawDesc) : "";
  const source =
    typeof item.source === "string"
      ? item.source.trim()
      : typeof item._sourceLabel === "string"
        ? item._sourceLabel.trim()
        : "";
  const url =
    typeof item.url === "string" && item.url.trim()
      ? item.url.trim()
      : typeof item.mobileUrl === "string" && item.mobileUrl.trim()
        ? item.mobileUrl.trim()
        : "";

  const directText = item.text || item.content || item.news;
  if (typeof directText === "string" && directText.trim() && !title) {
    const cleanedDirect = cleanHtml(directText);
    return {
      source,
      title: cleanedDirect.slice(0, 120),
      desc,
      url,
      formattedText: cleanedDirect,
      newsHash: cleanedDirect ? hashNewsText(cleanedDirect) : "",
    };
  }

  const parts: string[] = [];
  if (source) {
    parts.push(`【来源】${source}`);
  }
  if (title) {
    parts.push(`【标题】${title}`);
  }
  if (desc && desc !== title) {
    parts.push(`【摘要】${desc}`);
  }

  let formattedText = parts.join("\n");
  if (!formattedText && typeof directText === "string") {
    formattedText = cleanHtml(directText);
  }

  return {
    source,
    title,
    desc,
    url,
    formattedText,
    newsHash: formattedText ? hashNewsText(formattedText) : "",
  };
};

/**
 * 将输入的字符串或新闻对象规范化为待评分文本
 */
export const formatNewsInput = (item: string | ScoreInputItem): string => {
  return extractNewsMetadata(item).formattedText;
};

const pickScoreValue = (obj: any): number | null => {  for (const key of ["score", "Score", "评分", "分数"]) {
    const value = obj?.[key];
    if (typeof value === "number" && !Number.isNaN(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
      return Number(value);
    }
  }
  return null;
};

const pickReasonValue = (obj: any): string => {
  for (const key of ["reason", "Reason", "理由", "依据", "说明"]) {
    const value = obj?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
};

/**
 * 解析模型返回内容，三级降级：
 * 1. 去代码围栏 + 截取首尾大括号后 JSON.parse
 * 2. 宽松字段名（score/评分/分数、reason/理由）
 * 3. 仅含数字时取首个 0~100 数字，标记 degraded
 * 4. 全部失败返回 null（调用方决定不写库）
 */
export const parseScoreResponse = (rawContent: string): ScoreResult | null => {
  let content = (rawContent || "").trim();
  if (!content) return null;

  if (content.startsWith("```")) {
    content = content.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "").trim();
  }

  const firstBrace = content.indexOf("{");
  const lastBrace = content.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    content = content.slice(firstBrace, lastBrace + 1);
  }

  try {
    const parsed = JSON.parse(content);
    const rawScore = pickScoreValue(parsed);
    if (rawScore === null) {
      return null;
    }
    const score = Math.max(0, Math.min(100, Math.round(rawScore)));
    return {
      score,
      reason: pickReasonValue(parsed),
    };
  } catch {
    // 继续降级
  }

  const numberMatch = content.match(/\b(\d{1,3})\b/);
  if (numberMatch) {
    const parsedNumber = Number(numberMatch[1]);
    if (!Number.isNaN(parsedNumber) && parsedNumber >= 0 && parsedNumber <= 100) {
      const score = Math.round(parsedNumber);
      logger.warn(
        `⚠️ [Scorer] 模型输出无法解析为 JSON，已按纯数字降级：score=${score} raw=${content.slice(0, 80)}`,
      );
      return {
        score,
        reason: "模型未返回结构化理由",
        degraded: true,
      };
    }
  }

  return null;
};

export interface ScoreCompletionResult {
  raw: string;
  parsed: ScoreResult | null;
  latencyMs: number;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** 思维链 token（计入 completionTokens，是预算的主要泄漏点） */
    reasoningTokens: number;
    /** 命中上下文缓存的输入 token（价格约为未命中的 1/25） */
    cachedTokens: number;
  } | null;
}

/**
 * 组装 Chat Completions 请求体。
 * 评分场景只需「短 JSON」，因此默认关闭思考模式并限死 max_tokens，
 * 全部字段由环境变量控制，留空/0 即回退到服务端默认行为。
 */
export const buildCompletionPayload = (messages: ReturnType<typeof buildScoreMessages>) => {
  const payload: Record<string, unknown> = {
    model: config.DEEPSEEK_MODEL,
    messages,
    temperature: Number.isFinite(config.DEEPSEEK_TEMPERATURE) ? config.DEEPSEEK_TEMPERATURE : 0.1,
  };

  const thinking = config.DEEPSEEK_THINKING.toLowerCase();
  const effort = config.DEEPSEEK_REASONING_EFFORT.toLowerCase();

  // 归一化，避免下发互相冲突的开关：reasoning_effort=none 等价于关闭思考
  let effectiveThinking = thinking === "enabled" || thinking === "disabled" ? thinking : "";
  if (effort === "none") {
    effectiveThinking = "disabled";
  }

  if (effectiveThinking) {
    payload.thinking = { type: effectiveThinking };
  }

  // 仅在明确开启思考时下发强度；关闭思考时服务端不接受非 none 的强度值
  if (effort && effort !== "none" && effectiveThinking !== "disabled") {
    payload.reasoning_effort = effort;
  }

  if (config.DEEPSEEK_MAX_TOKENS > 0) {
    payload.max_tokens = config.DEEPSEEK_MAX_TOKENS;
  }

  if (config.DEEPSEEK_JSON_MODE) {
    payload.response_format = { type: "json_object" };
  }

  return payload;
};

/**
 * 调用 DeepSeek 完成一次评分（供正常评分与 Prompt 试跑复用）
 */
export const requestScoreCompletion = async (
  systemPrompt: string,
  formattedText: string,
  options: { timeout?: number } = {},
): Promise<ScoreCompletionResult> => {
  const apiKey = config.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is not configured");
  }

  const startedAt = Date.now();
  const response = await axios.post(
    `${config.DEEPSEEK_BASE_URL.replace(/\/+$/, "")}/chat/completions`,
    buildCompletionPayload(buildScoreMessages(systemPrompt, formattedText)),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      timeout: options.timeout ?? 45000,
    },
  );

  const raw = response?.data?.choices?.[0]?.message?.content || "";
  const rawUsage = response?.data?.usage;
  const usage = rawUsage
    ? {
        promptTokens: Number(rawUsage.prompt_tokens ?? 0),
        completionTokens: Number(rawUsage.completion_tokens ?? 0),
        totalTokens: Number(rawUsage.total_tokens ?? 0),
        reasoningTokens: Number(
          rawUsage.completion_tokens_details?.reasoning_tokens ??
            rawUsage.reasoning_tokens ??
            0,
        ),
        cachedTokens: Number(
          rawUsage.prompt_cache_hit_tokens ?? rawUsage.prompt_tokens_details?.cached_tokens ?? 0,
        ),
      }
    : null;

  return {
    raw,
    parsed: parseScoreResponse(raw),
    latencyMs: Date.now() - startedAt,
    model: config.DEEPSEEK_MODEL,
    usage,
  };
};

/**
 * 对单条新闻进行喜好度预测打分：
 * 1. 先查当前用户在数据库中是否有「同一 prompt 指纹」或「手动修正」记录，命中直接返回
 * 2. 未命中则用该用户的 prompt 请求 DeepSeek，并把结果持久化
 */
export const scoreNewsItem = async (
  input: string | ScoreInputItem,
  ctx: ScoreRunContext,
  options: ScoreOptions = {},
): Promise<ScoreResult> => {
  const { forceRescore = false } = options;
  const meta = extractNewsMetadata(input);
  const { formattedText, newsHash } = meta;

  if (!formattedText || !newsHash) {
    return {
      score: 0,
      reason: "新闻内容为空",
      fromCache: false,
    };
  }

  if (!forceRescore) {
    try {
      const dbRecord = await getScoreRecordByHash(ctx.userId, newsHash);
      const usable =
        dbRecord &&
        ((dbRecord.ai_score >= 0 && dbRecord.prompt_hash === ctx.promptHash) ||
          Boolean(dbRecord.is_user_modified));
      if (usable && dbRecord) {
        return rowToScoreResult(dbRecord, true);
      }
    } catch (dbErr) {
      logger.warn(
        `⚠️ [Scorer] Database lookup error: ${dbErr instanceof Error ? dbErr.message : "Unknown error"}`,
      );
    }
  }

  const completion = await requestScoreCompletion(ctx.promptText, formattedText);
  const parsed = completion.parsed;

  if (!parsed) {
    logger.error(
      `❌ [Scorer] 解析失败 user=${ctx.userId} prompt=${ctx.promptHash.slice(0, 8)} raw=${completion.raw.slice(0, 120)}`,
    );
    throw new Error("Failed to parse model response as valid score JSON");
  }

  try {
    const savedRow = await saveAiScoreRecord(ctx.userId, {
      newsHash,
      source: meta.source,
      title: meta.title,
      desc: meta.desc,
      url: meta.url,
      formattedText,
      aiScore: parsed.score,
      aiReason: parsed.reason,
      aiModel: completion.model,
      promptHash: ctx.promptHash,
    });

    const tokenInfo = completion.usage
      ? ` tokens=in${completion.usage.promptTokens}/out${completion.usage.completionTokens}/think${completion.usage.reasoningTokens}/cache${completion.usage.cachedTokens}`
      : "";

    logger.info(
      `🎯 [Scorer] 已评分并入库 user=${ctx.userId} (${parsed.score}): ${formattedText.slice(0, 40)}...${tokenInfo}`,
    );

    return {
      ...rowToScoreResult(savedRow, false),
      usage: completion.usage ?? null,
    };
  } catch (saveError) {
    logger.error(
      `❌ [Scorer] 评分入库失败 user=${ctx.userId}: ${saveError instanceof Error ? saveError.message : "Unknown error"}`,
    );
    return {
      ...parsed,
      newsHash,
      aiScore: parsed.score,
      aiReason: parsed.reason,
      isUserModified: false,
      isRead: false,
      fromCache: false,
      usage: completion.usage ?? null,
    };
  }
};

export interface ManualScoreInput extends ScoreInputItem {
  recordId?: number;
  newsHash?: string;
  userScore?: number | null;
  score?: number | null;
  userReason?: string | null;
  reason?: string | null;
  comment?: string | null;
  feedback?: string | null;
  reset?: boolean;
  aiScore?: number;
  aiReason?: string;
}

/**
 * 接收用户手动修正单条新闻分数的逻辑封装
 */
export const updateManualScoreItem = async (
  userId: number,
  payload: ManualScoreInput,
): Promise<ScoreResult> => {
  const meta = extractNewsMetadata(payload);
  const recordId =
    typeof payload.recordId === "number"
      ? payload.recordId
      : typeof payload.id === "number"
        ? payload.id
        : typeof payload.id === "string" && /^\d+$/.test(payload.id)
          ? parseInt(payload.id, 10)
          : undefined;

  const targetHash =
    typeof payload.newsHash === "string" && payload.newsHash.trim()
      ? payload.newsHash.trim()
      : meta.newsHash;

  const rawScore = payload.userScore !== undefined ? payload.userScore : payload.score;
  let userScore: number | null | undefined;
  if (rawScore === null) {
    userScore = null;
  } else if (typeof rawScore === "number") {
    userScore = rawScore;
  } else if (typeof rawScore === "string" && (rawScore as string).trim() !== "") {
    userScore = Number(rawScore);
  } else {
    userScore = undefined;
  }

  const rawReason =
    payload.userReason ?? payload.reason ?? payload.comment ?? payload.feedback ?? undefined;

  const saveParams: SaveUserManualScoreParams = {
    id: recordId,
    newsHash: targetHash || undefined,
    source: meta.source,
    title: meta.title,
    desc: meta.desc,
    url: meta.url,
    formattedText: meta.formattedText || undefined,
    userScore,
    userReason: typeof rawReason === "string" ? rawReason : null,
    reset: payload.reset === true || rawScore === null,
    aiScore: typeof payload.aiScore === "number" ? payload.aiScore : undefined,
    aiReason: typeof payload.aiReason === "string" ? payload.aiReason : undefined,
  };

  const updatedRow = await saveUserManualScore(userId, saveParams);
  if (!updatedRow) {
    throw new Error(
      "未找到对应的新闻评分记录，请提供有效的 id / newsHash，或提供完整的新闻内容（如 title、desc、source）以创建记录",
    );
  }

  logger.info(
    `✏️ [Scorer] 用户手动修正 user=${userId} (id=${updatedRow.id}, ai=${updatedRow.ai_score} -> user=${updatedRow.user_score}): ${updatedRow.title || updatedRow.news_hash}`,
  );

  return rowToScoreResult(updatedRow, true);
};

export interface ReadStatusInput extends ScoreInputItem {
  recordId?: number;
  newsHash?: string;
  isRead?: boolean;
}

/**
 * 标记或更新当前用户单条新闻的已读状态
 */
export const updateNewsReadStatusItem = async (
  userId: number,
  payload: ReadStatusInput,
): Promise<ScoreResult> => {
  const meta = extractNewsMetadata(payload);
  const recordId =
    typeof payload.recordId === "number"
      ? payload.recordId
      : typeof payload.id === "number"
        ? payload.id
        : typeof payload.id === "string" && /^\d+$/.test(payload.id)
          ? parseInt(payload.id, 10)
          : undefined;

  const targetHash =
    typeof payload.newsHash === "string" && payload.newsHash.trim()
      ? payload.newsHash.trim()
      : meta.newsHash;

  const saveParams: SaveNewsReadStatusParams = {
    id: recordId,
    newsHash: targetHash || undefined,
    source: meta.source,
    title: meta.title,
    desc: meta.desc,
    url: meta.url,
    formattedText: meta.formattedText || undefined,
    isRead: payload.isRead !== undefined ? Boolean(payload.isRead) : true,
  };

  const updatedRow = await saveNewsReadStatus(userId, saveParams);
  if (!updatedRow) {
    throw new Error(
      "未找到对应的新闻记录，请提供有效的 id / newsHash，或提供完整的新闻内容（如 title、desc、source）以记录已读状态",
    );
  }

  return rowToScoreResult(updatedRow, true);
};

/**
 * 批量对多条新闻进行喜好度预测打分（带并发控制与单条降级保护）
 */
export const scoreNewsBatch = async <T extends string | ScoreInputItem>(
  items: T[],
  ctx: ScoreRunContext,
  options: ScoreOptions = {},
): Promise<Array<(T extends string ? { text: string } : T) & ScoreResult>> => {
  if (!items || items.length === 0) {
    return [];
  }

  const concurrency = Math.max(1, Math.min(options.concurrency || 10, 20));
  const results = new Array(items.length);
  let currentIndex = 0;

  const worker = async () => {
    while (currentIndex < items.length) {
      const idx = currentIndex++;
      const item = items[idx];
      try {
        const scoreRes = await scoreNewsItem(item, ctx, options);
        if (typeof item === "string") {
          results[idx] = {
            text: item,
            ...scoreRes,
          };
        } else {
          results[idx] = {
            ...item,
            ...scoreRes,
          };
        }
      } catch (error) {
        logger.error(
          `❌ [Scorer] Batch item #${idx} score error: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
        const fallback: ScoreResult = {
          score: 50,
          reason: "评分失败降级[待复核]",
          fromCache: false,
        };
        if (typeof item === "string") {
          results[idx] = {
            text: item,
            ...fallback,
          };
        } else {
          results[idx] = {
            ...item,
            ...fallback,
          };
        }
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);

  return results;
};

export interface CachedLookupResult extends Partial<ScoreResult> {
  newsHash: string;
  hit: boolean;
  isRead: boolean;
}

/**
 * 批量仅查询当前用户的缓存评分（不触发 AI 调用）
 * 命中条件：同一 prompt 指纹下已完成 AI 评分，或用户手动修正过
 */
export const lookupCachedScoresBatch = async (
  userId: number,
  items: Array<string | ScoreInputItem>,
  promptHash: string,
): Promise<CachedLookupResult[]> => {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const metas = items.map((item) => extractNewsMetadata(item));
  const hashes = metas.map((m) => m.newsHash).filter(Boolean);

  let recordsMap = new Map<string, NewsScoreRow>();
  try {
    recordsMap = await getScoreRecordsByHashes(userId, hashes);
  } catch (err) {
    logger.warn(
      `⚠️ [Scorer] Batch cache lookup error: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }

  return metas.map((meta) => {
    const { newsHash } = meta;
    if (!newsHash) {
      return {
        newsHash: "",
        hit: false,
        isRead: false,
      };
    }

    const dbRecord = recordsMap.get(newsHash);
    if (!dbRecord) {
      return {
        newsHash,
        hit: false,
        isRead: false,
      };
    }

    const promptMatched = dbRecord.ai_score >= 0 && dbRecord.prompt_hash === promptHash;
    if (promptMatched || Boolean(dbRecord.is_user_modified)) {
      return {
        ...rowToScoreResult(dbRecord, true),
        newsHash,
        hit: true,
        isRead: Boolean(dbRecord.is_read),
      };
    }

    // 仅有已读占位记录（ai_score = -1）或 prompt 已变更，均视为未命中
    return {
      newsHash,
      hit: false,
      isRead: Boolean(dbRecord.is_read),
    };
  });
};
