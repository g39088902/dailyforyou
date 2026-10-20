import { config } from "../config.js";
import { closeDatabase, executeSql, queryOne, queryRows } from "../db/client.js";
import { runMigrations } from "./migrations.js";
import type { ScoreLayer, ScoreResult } from "../types.js";

/**
 * 用户服务自己的评分记录（含最小索引字段：来源/标题/链接）。
 * 注意：不包含新闻正文与翻译，正文只存在于爬虫服务的 news_items。
 */
export interface NewsScoreRow {
  id: number;
  user_id: number;
  news_hash: string;
  source: string;
  title: string;
  url: string;
  ai_score: number;
  ai_layer: string;
  ai_reason: string;
  ai_model: string;
  prompt_hash: string;
  user_score: number | null;
  user_layer: string | null;
  user_reason: string | null;
  is_user_modified: number;
  user_updated_at: string | null;
  is_read: number;
  read_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewsIndexFields {
  newsHash: string;
  source?: string;
  title?: string;
  url?: string;
}

export interface SaveAiScoreParams extends NewsIndexFields {
  desc?: string;
  formattedText?: string;
  aiScore: number;
  aiLayer: ScoreLayer;
  aiReason: string;
  aiModel?: string;
  promptHash?: string;
}

export interface SaveUserManualScoreParams extends Partial<NewsIndexFields> {
  id?: number;
  desc?: string;
  formattedText?: string;
  userScore?: number | null;
  userLayer?: ScoreLayer | null;
  userReason?: string | null;
  reset?: boolean;
  aiScore?: number;
  aiLayer?: ScoreLayer;
  aiReason?: string;
}

export interface SaveNewsReadStatusParams extends Partial<NewsIndexFields> {
  id?: number;
  desc?: string;
  formattedText?: string;
  isRead?: boolean;
}

export interface QueryScoreRecordsParams {
  onlyUserModified?: boolean;
  onlyRead?: boolean;
  source?: string;
  limit?: number;
  offset?: number;
}

const VALID_LAYERS = new Set<ScoreLayer>(["L1", "L2", "L3", "L4", "L5", "Uncertain"]);

/**
 * 根据分数推断默认分层
 */
export const inferLayerFromScore = (score: number): ScoreLayer => {
  if (score >= 90) return "L1";
  if (score >= 75) return "L2";
  if (score >= 60) return "L4";
  if (score >= 40) return "Uncertain";
  return "L5";
};

let initPromise: Promise<void> | null = null;

/**
 * 初始化用户数据库：建立连接并执行迁移
 */
export const initScoreDb = async (): Promise<void> => {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    await runMigrations();
  })().catch((error) => {
    initPromise = null;
    throw error;
  });

  return initPromise;
};

export const closeScoreDb = async (): Promise<void> => {
  await closeDatabase();
  initPromise = null;
};

/**
 * 将数据库原始对象映射为严格契约的 NewsScoreRow
 */
const mapDbRow = (row: any): NewsScoreRow => {
  return {
    id: Number(row.id),
    user_id: Number(row.user_id ?? 0),
    news_hash: String(row.news_hash || ""),
    source: String(row.source || ""),
    title: String(row.title || ""),
    url: String(row.url || ""),
    ai_score: Number(row.ai_score ?? -1),
    ai_layer: String(row.ai_layer || "Uncertain"),
    ai_reason: String(row.ai_reason || ""),
    ai_model: String(row.ai_model || ""),
    prompt_hash: String(row.prompt_hash || ""),
    user_score:
      row.user_score !== null && row.user_score !== undefined ? Number(row.user_score) : null,
    user_layer: row.user_layer ? String(row.user_layer) : null,
    user_reason: row.user_reason ? String(row.user_reason) : null,
    is_user_modified: Number(row.is_user_modified || 0),
    user_updated_at: row.user_updated_at ? String(row.user_updated_at) : null,
    is_read: Number(row.is_read || 0),
    read_at: row.read_at ? String(row.read_at) : null,
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
  };
};

/**
 * 将数据库行转换为对外返回的 ScoreResult
 */
export const rowToScoreResult = (row: NewsScoreRow, fromCache: boolean): ScoreResult => {
  const isUserModified = Boolean(row.is_user_modified) && typeof row.user_score === "number";
  const aiLayer: ScoreLayer = VALID_LAYERS.has(row.ai_layer as ScoreLayer)
    ? (row.ai_layer as ScoreLayer)
    : "Uncertain";
  const userLayer: ScoreLayer | null =
    row.user_layer && VALID_LAYERS.has(row.user_layer as ScoreLayer)
      ? (row.user_layer as ScoreLayer)
      : isUserModified && typeof row.user_score === "number"
        ? inferLayerFromScore(row.user_score)
        : null;

  const effectiveScore = isUserModified ? (row.user_score as number) : row.ai_score;
  const effectiveLayer: ScoreLayer = isUserModified && userLayer ? userLayer : aiLayer;
  const effectiveReason =
    isUserModified && row.user_reason && row.user_reason.trim()
      ? row.user_reason
      : row.ai_reason;

  return {
    id: row.id,
    newsHash: row.news_hash,
    score: effectiveScore,
    layer: effectiveLayer,
    reason: effectiveReason,
    aiScore: row.ai_score,
    aiLayer,
    aiReason: row.ai_reason,
    userScore: row.user_score,
    userLayer,
    userReason: row.user_reason,
    isUserModified: Boolean(row.is_user_modified),
    userUpdatedAt: row.user_updated_at,
    isRead: Boolean(row.is_read),
    readAt: row.read_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    fromCache,
  };
};

/**
 * 按 news_hash 查询当前用户的评分记录
 */
export const getScoreRecordByHash = async (
  userId: number,
  newsHash: string,
): Promise<NewsScoreRow | null> => {
  if (!newsHash) return null;
  const row = await queryOne(
    `SELECT * FROM user_news_states WHERE user_id = ? AND news_hash = ? LIMIT 1`,
    [userId, newsHash],
  );
  return row ? mapDbRow(row) : null;
};

/**
 * 批量按 news_hash 检索当前用户的评分记录
 */
export const getScoreRecordsByHashes = async (
  userId: number,
  hashes: string[],
): Promise<Map<string, NewsScoreRow>> => {
  const result = new Map<string, NewsScoreRow>();
  const cleanHashes = [...new Set(hashes.filter(Boolean))];
  if (cleanHashes.length === 0) return result;

  const chunkSize = 50;
  for (let i = 0; i < cleanHashes.length; i += chunkSize) {
    const chunk = cleanHashes.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await queryRows(
      `SELECT * FROM user_news_states WHERE user_id = ? AND news_hash IN (${placeholders})`,
      [userId, ...chunk],
    );
    for (const r of rows) {
      const mapped = mapDbRow(r);
      result.set(mapped.news_hash, mapped);
    }
  }

  return result;
};

/**
 * 按主键 ID 查询当前用户的评分记录（跨用户不可见）
 */
export const getScoreRecordById = async (
  userId: number,
  id: number,
): Promise<NewsScoreRow | null> => {
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await queryOne(
    `SELECT * FROM user_news_states WHERE user_id = ? AND id = ? LIMIT 1`,
    [userId, id],
  );
  return row ? mapDbRow(row) : null;
};

/**
 * 写入或更新当前用户的 AI 评分记录（同时落一份最小索引字段）
 */
export const saveAiScoreRecord = async (
  userId: number,
  params: SaveAiScoreParams,
): Promise<NewsScoreRow> => {
  const now = new Date().toISOString();
  const aiModel = (params.aiModel || config.DEEPSEEK_MODEL || "").trim();

  await executeSql(
    `
    INSERT INTO user_news_states (
      user_id, news_hash, source, title, url,
      ai_score, ai_layer, ai_reason, ai_model, prompt_hash,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, news_hash) DO UPDATE SET
      source = CASE WHEN excluded.source != '' THEN excluded.source ELSE user_news_states.source END,
      title = CASE WHEN excluded.title != '' THEN excluded.title ELSE user_news_states.title END,
      url = CASE WHEN excluded.url != '' THEN excluded.url ELSE user_news_states.url END,
      ai_score = excluded.ai_score,
      ai_layer = excluded.ai_layer,
      ai_reason = excluded.ai_reason,
      ai_model = excluded.ai_model,
      prompt_hash = excluded.prompt_hash,
      updated_at = excluded.updated_at
    `,
    [
      userId,
      params.newsHash,
      (params.source || "").trim(),
      (params.title || "").trim(),
      (params.url || "").trim(),
      params.aiScore,
      params.aiLayer,
      params.aiReason,
      aiModel,
      params.promptHash || "",
      now,
      now,
    ],
  );

  const saved = await getScoreRecordByHash(userId, params.newsHash);
  if (!saved) {
    throw new Error("Failed to read back saved AI score record from database");
  }
  return saved;
};

/**
 * 保存或重置当前用户手动修正的评分
 */
export const saveUserManualScore = async (
  userId: number,
  params: SaveUserManualScoreParams,
): Promise<NewsScoreRow | null> => {
  const now = new Date().toISOString();

  let existing: NewsScoreRow | null = null;
  if (typeof params.id === "number" && Number.isInteger(params.id) && params.id > 0) {
    existing = await getScoreRecordById(userId, params.id);
  }
  if (!existing && params.newsHash) {
    existing = await getScoreRecordByHash(userId, params.newsHash);
  }

  const isReset = params.reset === true || params.userScore === null;

  if (existing) {
    const source = (params.source || "").trim();
    const title = (params.title || "").trim();
    const url = (params.url || "").trim();

    if (isReset) {
      await executeSql(
        `
        UPDATE user_news_states
        SET user_score = NULL,
            user_layer = NULL,
            user_reason = NULL,
            is_user_modified = 0,
            user_updated_at = NULL,
            updated_at = ?,
            source = CASE WHEN ? != '' THEN ? ELSE source END,
            title = CASE WHEN ? != '' THEN ? ELSE title END,
            url = CASE WHEN ? != '' THEN ? ELSE url END
        WHERE id = ? AND user_id = ?
        `,
        [now, source, source, title, title, url, url, existing.id, userId],
      );
      return await getScoreRecordById(userId, existing.id);
    }

    if (typeof params.userScore !== "number" || Number.isNaN(params.userScore)) {
      throw new Error("请提供有效的修正分数 userScore（0~100 整数）");
    }

    const clampedScore = Math.max(0, Math.min(100, Math.round(params.userScore)));
    const resolvedLayer: ScoreLayer =
      params.userLayer && VALID_LAYERS.has(params.userLayer)
        ? params.userLayer
        : inferLayerFromScore(clampedScore);
    const resolvedReason =
      typeof params.userReason === "string" ? params.userReason.trim() : existing.user_reason;

    await executeSql(
      `
      UPDATE user_news_states
      SET user_score = ?,
          user_layer = ?,
          user_reason = ?,
          is_user_modified = 1,
          user_updated_at = ?,
          updated_at = ?,
          source = CASE WHEN ? != '' THEN ? ELSE source END,
          title = CASE WHEN ? != '' THEN ? ELSE title END,
          url = CASE WHEN ? != '' THEN ? ELSE url END
      WHERE id = ? AND user_id = ?
      `,
      [
        clampedScore,
        resolvedLayer,
        resolvedReason ?? null,
        now,
        now,
        source,
        source,
        title,
        title,
        url,
        url,
        existing.id,
        userId,
      ],
    );

    return await getScoreRecordById(userId, existing.id);
  }

  // 尚无记录：reset 无意义，直接返回
  if (isReset) return null;
  if (!params.newsHash) return null;
  if (typeof params.userScore !== "number" || Number.isNaN(params.userScore)) {
    throw new Error("请提供有效的修正分数 userScore（0~100 整数）");
  }

  const clampedScore = Math.max(0, Math.min(100, Math.round(params.userScore)));
  const resolvedLayer: ScoreLayer =
    params.userLayer && VALID_LAYERS.has(params.userLayer)
      ? params.userLayer
      : inferLayerFromScore(clampedScore);
  const resolvedReason =
    typeof params.userReason === "string" ? params.userReason.trim() : null;

  const initialAiScore =
    typeof params.aiScore === "number" && !Number.isNaN(params.aiScore)
      ? Math.max(0, Math.min(100, Math.round(params.aiScore)))
      : clampedScore;
  const initialAiLayer: ScoreLayer =
    params.aiLayer && VALID_LAYERS.has(params.aiLayer) ? params.aiLayer : resolvedLayer;
  const initialAiReason =
    typeof params.aiReason === "string" && params.aiReason.trim()
      ? params.aiReason.trim()
      : "用户直接手动打分（未经过AI初评）";

  await executeSql(
    `
    INSERT INTO user_news_states (
      user_id, news_hash, source, title, url,
      ai_score, ai_layer, ai_reason, ai_model, prompt_hash,
      user_score, user_layer, user_reason, is_user_modified, user_updated_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(user_id, news_hash) DO UPDATE SET
      user_score = excluded.user_score,
      user_layer = excluded.user_layer,
      user_reason = excluded.user_reason,
      is_user_modified = 1,
      user_updated_at = excluded.user_updated_at,
      updated_at = excluded.updated_at,
      source = CASE WHEN excluded.source != '' THEN excluded.source ELSE user_news_states.source END,
      title = CASE WHEN excluded.title != '' THEN excluded.title ELSE user_news_states.title END,
      url = CASE WHEN excluded.url != '' THEN excluded.url ELSE user_news_states.url END,
      ai_score = CASE WHEN user_news_states.ai_score < 0 THEN excluded.ai_score ELSE user_news_states.ai_score END,
      ai_layer = CASE WHEN user_news_states.ai_score < 0 THEN excluded.ai_layer ELSE user_news_states.ai_layer END,
      ai_reason = CASE WHEN user_news_states.ai_score < 0 THEN excluded.ai_reason ELSE user_news_states.ai_reason END
    `,
    [
      userId,
      params.newsHash,
      (params.source || "").trim(),
      (params.title || "").trim(),
      (params.url || "").trim(),
      initialAiScore,
      initialAiLayer,
      initialAiReason,
      config.DEEPSEEK_MODEL || "",
      clampedScore,
      resolvedLayer,
      resolvedReason,
      now,
      now,
      now,
    ],
  );

  return await getScoreRecordByHash(userId, params.newsHash);
};

/**
 * 保存或更新当前用户单条新闻的已读状态
 */
export const saveNewsReadStatus = async (
  userId: number,
  params: SaveNewsReadStatusParams,
): Promise<NewsScoreRow | null> => {
  const now = new Date().toISOString();
  const isRead = params.isRead !== undefined ? Boolean(params.isRead) : true;
  const isReadVal = isRead ? 1 : 0;
  const readAtVal = isRead ? now : null;

  let existing: NewsScoreRow | null = null;
  if (typeof params.id === "number" && Number.isInteger(params.id) && params.id > 0) {
    existing = await getScoreRecordById(userId, params.id);
  }
  if (!existing && params.newsHash) {
    existing = await getScoreRecordByHash(userId, params.newsHash);
  }

  if (existing) {
    const source = (params.source || "").trim();
    const title = (params.title || "").trim();
    const url = (params.url || "").trim();

    await executeSql(
      `
      UPDATE user_news_states
      SET is_read = ?,
          read_at = CASE WHEN ? = 1 THEN COALESCE(read_at, ?) ELSE NULL END,
          updated_at = ?,
          source = CASE WHEN ? != '' THEN ? ELSE source END,
          title = CASE WHEN ? != '' THEN ? ELSE title END,
          url = CASE WHEN ? != '' THEN ? ELSE url END
      WHERE id = ? AND user_id = ?
      `,
      [
        isReadVal,
        isReadVal,
        readAtVal,
        now,
        source,
        source,
        title,
        title,
        url,
        url,
        existing.id,
        userId,
      ],
    );

    return await getScoreRecordById(userId, existing.id);
  }

  if (!params.newsHash) return null;

  await executeSql(
    `
    INSERT INTO user_news_states (
      user_id, news_hash, source, title, url,
      ai_score, ai_layer, ai_reason, ai_model, prompt_hash,
      is_read, read_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, -1, 'Uncertain', '', '', '', ?, ?, ?, ?)
    ON CONFLICT(user_id, news_hash) DO UPDATE SET
      is_read = excluded.is_read,
      read_at = CASE WHEN excluded.is_read = 1
                    THEN COALESCE(user_news_states.read_at, excluded.read_at)
                    ELSE NULL END,
      updated_at = excluded.updated_at,
      source = CASE WHEN excluded.source != '' THEN excluded.source ELSE user_news_states.source END,
      title = CASE WHEN excluded.title != '' THEN excluded.title ELSE user_news_states.title END,
      url = CASE WHEN excluded.url != '' THEN excluded.url ELSE user_news_states.url END
    `,
    [
      userId,
      params.newsHash,
      (params.source || "").trim(),
      (params.title || "").trim(),
      (params.url || "").trim(),
      isReadVal,
      readAtVal,
      now,
      now,
    ],
  );

  return await getScoreRecordByHash(userId, params.newsHash);
};

/**
 * 获取当前用户所有已读新闻的 newsHash 列表
 */
export const getAllReadNewsHashes = async (userId: number, limit = 5000): Promise<string[]> => {
  const safeLimit = Math.max(1, Math.min(limit, 20000));
  const rows = await queryRows(
    `
    SELECT news_hash FROM user_news_states
    WHERE user_id = ? AND is_read = 1
    ORDER BY COALESCE(read_at, updated_at) DESC
    LIMIT ?
    `,
    [userId, safeLimit],
  );
  return rows.map((r: any) => String(r.news_hash)).filter(Boolean);
};

/**
 * 查询当前用户的评分记录列表
 */
export const queryScoreRecords = async (
  userId: number,
  params: QueryScoreRecordsParams = {},
): Promise<{ total: number; items: NewsScoreRow[] }> => {
  const conditions: string[] = ["user_id = ?"];
  const bindValues: Array<string | number> = [userId];

  if (params.onlyUserModified) {
    conditions.push("is_user_modified = 1");
  }
  if (params.onlyRead !== undefined) {
    conditions.push("is_read = ?");
    bindValues.push(params.onlyRead ? 1 : 0);
  }
  if (params.source && params.source.trim()) {
    conditions.push("source = ?");
    bindValues.push(params.source.trim());
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;
  const limit = Math.max(1, Math.min(params.limit || 100, 500));
  const offset = Math.max(0, params.offset || 0);

  const countRow = await queryOne(
    `SELECT COUNT(*) AS total FROM user_news_states ${whereClause}`,
    bindValues,
  );
  const total = Number(countRow?.total ?? 0);

  const rows = await queryRows(
    `
    SELECT * FROM user_news_states
    ${whereClause}
    ORDER BY CASE WHEN is_user_modified = 1 THEN user_updated_at ELSE updated_at END DESC, id DESC
    LIMIT ? OFFSET ?
    `,
    [...bindValues, limit, offset],
  );

  return { total, items: rows.map((r: any) => mapDbRow(r)) };
};
