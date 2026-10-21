import axios from "axios";
import { config } from "../config.js";
import logger from "./logger.js";

export interface TranslateOptions {
  texts: string[];
  targetLang?: string;
  sourceLang?: string;
  /** @deprecated 进程内缓存已移除，保留字段仅用于兼容既有调用方 */
  cacheTtl?: number;
  /** @deprecated 进程内缓存已移除，保留字段仅用于兼容既有调用方 */
  noCache?: boolean;
}

/**
 * 翻译单个或多个文本
 * @param texts 需要翻译的文本数组
 * @param targetLang 目标语言，默认 "zh-CN"（简体中文）
 * @param sourceLang 源语言，默认 "en"（英语）
 * @returns 对应顺序翻译后的纯文本数组
 */
export const translateTexts = async (options: TranslateOptions): Promise<string[]> => {
  const { texts, targetLang = "zh-CN", sourceLang = "en" } = options;

  if (!texts || texts.length === 0) {
    return [];
  }

  const apiKey = config.DEEPSEEK_API_KEY;
  if (!apiKey) {
    logger.warn("⚠️ [Translator] DEEPSEEK_API_KEY is not configured, returning original texts.");
    return texts;
  }

  const results: string[] = new Array(texts.length);
  const pendingIndices: number[] = [];
  const pendingTexts: string[] = [];

  for (let i = 0; i < texts.length; i++) {
    const originalText = texts[i];
    if (!originalText || !originalText.trim()) {
      results[i] = originalText;
      continue;
    }

    pendingIndices.push(i);
    pendingTexts.push(originalText);
  }

  // 没有需要翻译的文本
  if (pendingIndices.length === 0) {
    return results;
  }

  // 1. 将待翻译文本切片并并发调用 DeepSeek API 进行翻译（每批最多 3 条）
  const CHUNK_SIZE = 3;
  const chunks: { chunkIndices: number[]; chunkTexts: string[] }[] = [];
  for (let offset = 0; offset < pendingIndices.length; offset += CHUNK_SIZE) {
    chunks.push({
      chunkIndices: pendingIndices.slice(offset, offset + CHUNK_SIZE),
      chunkTexts: pendingTexts.slice(offset, offset + CHUNK_SIZE),
    });
  }

  await Promise.all(
    chunks.map(async ({ chunkIndices, chunkTexts }) => {
      try {
        const prompt = `You are a professional translator for global news, finance, technology headlines, and summaries.
Translate the following array of ${sourceLang} texts into natural, fluent, and accurate ${targetLang}.
Strict rules:
1. Return ONLY a valid JSON array of strings matching the exact length and order of the input.
2. Keep financial/technical terms, ticker symbols, company/brand names, and proper nouns in their standard recognized form (or original English if commonly untranslated).
3. Do not include markdown code blocks, explanatory comments, or quotes outside the array.

Input JSON:
${JSON.stringify(chunkTexts)}`;

        const response = await axios.post(
          `${config.DEEPSEEK_BASE_URL.replace(/\/+$/, "")}/chat/completions`,
          {
            model: config.DEEPSEEK_MODEL,
            messages: [
              {
                role: "system",
                content: "You are an accurate, concise translator. You only output valid JSON arrays.",
              },
              {
                role: "user",
                content: prompt,
              },
            ],
            temperature: 0.1,
          },
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            timeout: 45000,
          },
        );

        let content = response?.data?.choices?.[0]?.message?.content?.trim() || "";

        // 去除可能的 markdown 代码块包装
        if (content.startsWith("```")) {
          content = content.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "").trim();
        }

        let translatedList: string[] = [];
        try {
          translatedList = JSON.parse(content);
        } catch {
          logger.error(`❌ [Translator] Failed to parse DeepSeek response as JSON: ${content}`);
        }

        for (let k = 0; k < chunkIndices.length; k++) {
          const originalIdx = chunkIndices[k];
          results[originalIdx] = translatedList[k] || chunkTexts[k];
        }

        logger.info(`🌐 [Translator] Successfully translated batch of ${chunkIndices.length} items with DeepSeek.`);
      } catch (error) {
        logger.error(`❌ [Translator] DeepSeek translation error: ${error instanceof Error ? error.message : "Unknown error"}`);
        // 当前批次翻译失败降级为原文
        for (let k = 0; k < chunkIndices.length; k++) {
          const originalIdx = chunkIndices[k];
          results[originalIdx] = chunkTexts[k];
        }
      }
    }),
  );

  return results;
};
