import { config } from "../config.js";
import { executeSql, queryOne } from "../db/client.js";
import {
  DEFAULT_SCORE_PROMPT,
  NEWS_MESSAGE_PREFIX,
  hashPrompt,
} from "./scorePrompt.js";
import type { PromptContext } from "../types.js";

interface CachedPrompt {
  context: PromptContext;
  expiresAt: number;
}

const CACHE_TTL_MS = 60 * 1000;
const promptCache = new Map<number, CachedPrompt>();

const buildDefaultContext = (): PromptContext => ({
  prompt: DEFAULT_SCORE_PROMPT,
  promptHash: hashPrompt(DEFAULT_SCORE_PROMPT),
  isDefault: true,
});

/**
 * 读取用户评分 Prompt（缺失时自动补建默认值，带 60s 进程内缓存）
 */
export const getPromptContext = async (userId: number): Promise<PromptContext> => {
  const cached = promptCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.context;
  }

  const row = await queryOne(
    `SELECT score_prompt, prompt_hash FROM user_profiles WHERE user_id = ? LIMIT 1`,
    [userId],
  );

  let context: PromptContext;
  if (!row) {
    const now = new Date().toISOString();
    const fallback = buildDefaultContext();
    await executeSql(
      `INSERT INTO user_profiles
         (user_id, score_prompt, prompt_hash, prompt_updated_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO NOTHING`,
      [userId, fallback.prompt, fallback.promptHash, now, now, now],
    );
    context = fallback;
  } else {
    const prompt = String(row.score_prompt || "") || DEFAULT_SCORE_PROMPT;
    context = {
      prompt,
      promptHash: String(row.prompt_hash || "") || hashPrompt(prompt),
      isDefault: prompt === DEFAULT_SCORE_PROMPT,
    };
  }

  promptCache.set(userId, { context, expiresAt: Date.now() + CACHE_TTL_MS });
  return context;
};

export type PromptValidationResult =
  | { ok: true; warnings: string[] }
  | { ok: false; message: string };

/**
 * 读取 Prompt 元信息（供账户页展示，不走缓存）
 */
export const getPromptRecord = async (
  userId: number,
): Promise<{ prompt: string; promptHash: string; updatedAt: string }> => {
  const row = await queryOne(
    `SELECT score_prompt, prompt_hash, prompt_updated_at FROM user_profiles WHERE user_id = ? LIMIT 1`,
    [userId],
  );
  if (!row) {
    const fallback = buildDefaultContext();
    return { prompt: fallback.prompt, promptHash: fallback.promptHash, updatedAt: "" };
  }
  return {
    prompt: String(row.score_prompt || ""),
    promptHash: String(row.prompt_hash || ""),
    updatedAt: String(row.prompt_updated_at || ""),
  };
};

/**
 * 校验用户提交的 Prompt（允许完全自定义，仅做必要的注入与长度防护）
 */
export const validatePrompt = (prompt: unknown): PromptValidationResult => {
  if (typeof prompt !== "string") {
    return { ok: false, message: "prompt 必须是字符串" };
  }
  const trimmed = prompt.trim();
  if (trimmed.length < 50) {
    return { ok: false, message: `prompt 至少需要 50 个字符（当前 ${trimmed.length}）` };
  }
  if (trimmed.length > config.SCORE_PROMPT_MAX_LENGTH) {
    return {
      ok: false,
      message: `prompt 超出长度上限（${trimmed.length}/${config.SCORE_PROMPT_MAX_LENGTH}）`,
    };
  }
  if (trimmed.includes(NEWS_MESSAGE_PREFIX)) {
    return {
      ok: false,
      message: `prompt 不能包含「${NEWS_MESSAGE_PREFIX}」，该内容由服务端自动拼接`,
    };
  }

  const warnings: string[] = [];
  if (!trimmed.includes("{") || !/score/i.test(trimmed)) {
    warnings.push("prompt_suspicious_no_json_hint");
  }
  return { ok: true, warnings };
};

/**
 * 更新用户 Prompt，返回最新上下文
 */
export const updateUserPrompt = async (
  userId: number,
  prompt: string,
): Promise<PromptContext> => {
  const now = new Date().toISOString();
  const promptHash = hashPrompt(prompt);

  await executeSql(
    `INSERT INTO user_profiles
       (user_id, score_prompt, prompt_hash, prompt_updated_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       score_prompt = excluded.score_prompt,
       prompt_hash = excluded.prompt_hash,
       prompt_updated_at = excluded.prompt_updated_at,
       updated_at = excluded.updated_at`,
    [userId, prompt, promptHash, now, now, now],
  );

  const context: PromptContext = {
    prompt,
    promptHash,
    isDefault: prompt === DEFAULT_SCORE_PROMPT,
  };
  promptCache.set(userId, { context, expiresAt: Date.now() + CACHE_TTL_MS });
  return context;
};

/**
 * 重置为系统默认 Prompt
 */
export const resetUserPrompt = async (userId: number): Promise<PromptContext> =>
  updateUserPrompt(userId, DEFAULT_SCORE_PROMPT);

/**
 * 主动失效缓存（测试或外部写入后使用）
 */
export const invalidatePromptCache = (userId?: number): void => {
  if (userId === undefined) {
    promptCache.clear();
    return;
  }
  promptCache.delete(userId);
};
