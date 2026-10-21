import logger from "../utils/logger.js";
import { runBatch, type BatchStatement } from "./client.js";
import { buildNewsText } from "../utils/newsText.js";
import type { ListItem } from "../types.js";

export interface NewsRecord {
  newsHash: string;
  source: string;
  sourceName?: string;
  subType?: string;
  title: string;
  desc: string;
  url: string;
  mobileUrl?: string;
  hot?: string | number;
  cover?: string;
  pubTime?: string | number;
  formattedText: string;
}

const CHUNK_SIZE = 50;

/**
 * 把抓取（并已完成翻译）的条目转换为待入库记录
 */
export const toNewsRecords = (
  sourceLabel: string,
  items: ListItem[],
  options?: { sourceName?: string; subType?: string },
): NewsRecord[] => {
  const records: NewsRecord[] = [];
  for (const item of items) {
    const built = buildNewsText({
      source: sourceLabel,
      title: item.title || "",
      desc: item.desc || "",
    });
    if (!built.newsHash || !built.formattedText) continue;
    records.push({
      newsHash: built.newsHash,
      source: built.source,
      sourceName: options?.sourceName || "",
      subType: options?.subType || "",
      title: built.title,
      desc: built.desc,
      url: item.url || item.mobileUrl || "",
      mobileUrl: item.mobileUrl || "",
      hot: item.hot !== undefined ? String(item.hot) : "",
      cover: item.cover || "",
      pubTime: item.timestamp !== undefined ? String(item.timestamp) : "",
      formattedText: built.formattedText,
    });
  }
  return records;
};

const buildStatement = (record: NewsRecord, now: string): BatchStatement => ({
  sql: `
    INSERT INTO news_items (
      news_hash, source, source_name, sub_type, title, desc_text, url, mobile_url, hot, cover, pub_time, formatted_text, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(news_hash) DO UPDATE SET
      source = CASE WHEN excluded.source != '' THEN excluded.source ELSE news_items.source END,
      source_name = CASE WHEN excluded.source_name != '' THEN excluded.source_name ELSE news_items.source_name END,
      sub_type = CASE WHEN excluded.sub_type != '' THEN excluded.sub_type ELSE news_items.sub_type END,
      title = CASE WHEN excluded.title != '' THEN excluded.title ELSE news_items.title END,
      desc_text = CASE WHEN excluded.desc_text != '' THEN excluded.desc_text ELSE news_items.desc_text END,
      url = CASE WHEN excluded.url != '' THEN excluded.url ELSE news_items.url END,
      mobile_url = CASE WHEN excluded.mobile_url != '' THEN excluded.mobile_url ELSE news_items.mobile_url END,
      hot = CASE WHEN excluded.hot != '' THEN excluded.hot ELSE news_items.hot END,
      cover = CASE WHEN excluded.cover != '' THEN excluded.cover ELSE news_items.cover END,
      pub_time = CASE WHEN excluded.pub_time != '' THEN excluded.pub_time ELSE news_items.pub_time END,
      formatted_text = CASE WHEN excluded.formatted_text != '' THEN excluded.formatted_text ELSE news_items.formatted_text END,
      updated_at = excluded.updated_at
  `,
  args: [
    record.newsHash,
    record.source,
    record.sourceName || "",
    record.subType || "",
    record.title,
    record.desc,
    record.url,
    record.mobileUrl || "",
    String(record.hot ?? ""),
    record.cover || "",
    String(record.pubTime ?? ""),
    record.formattedText,
    now,
    now,
  ],
});

/**
 * 批量写入新闻库（单次抓取一批，按 chunk 控制单次事务大小）
 */
export const persistNewsRecords = async (records: NewsRecord[]): Promise<number> => {
  if (records.length === 0) return 0;

  const unique = new Map<string, NewsRecord>();
  for (const record of records) {
    unique.set(record.newsHash, record);
  }

  const now = new Date().toISOString();
  const all = [...unique.values()];
  let written = 0;

  for (let offset = 0; offset < all.length; offset += CHUNK_SIZE) {
    const chunk = all.slice(offset, offset + CHUNK_SIZE);
    await runBatch(chunk.map((record) => buildStatement(record, now)));
    written += chunk.length;
  }

  return written;
};

/**
 * 新闻库当前条数（健康检查用）
 */
export const countNewsItems = async (): Promise<number> => {
  const { queryOne } = await import("./client.js");
  const row = await queryOne(`SELECT COUNT(*) AS total FROM news_items`);
  return Number(row?.total ?? 0);
};

export const persistNewsSafely = async (
  sourceLabel: string,
  items: ListItem[],
  options?: { sourceName?: string; subType?: string },
): Promise<number> => {
  try {
    const records = toNewsRecords(sourceLabel, items, options);
    const written = await persistNewsRecords(records);
    if (written > 0) {
      logger.info(
        `🗂️ [NewsRepo] ${sourceLabel}${options?.sourceName ? ` (${options.sourceName}${options.subType ? `/${options.subType}` : ""})` : ""} 入库 ${written} 条`,
      );
    }
    return written;
  } catch (error) {
    logger.error(
      `❌ [NewsRepo] 入库失败（${sourceLabel}）：${error instanceof Error ? error.message : "Unknown error"}`,
    );
    return 0;
  }
};
