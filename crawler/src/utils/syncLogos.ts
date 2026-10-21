import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import logger from "./logger.js";
import { executeSql, queryRows, queryOne } from "../db/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGOS_DIR = path.resolve(__dirname, "../../assets/logos");

const MAX_LOGO_BYTES = 256 * 1024; // 256KB

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

/**
 * 轻量解析图片宽高（免额外二进制依赖）
 */
const parseImageDimensions = (
  ext: string,
  buffer: Buffer,
): { width: number; height: number } => {
  if (ext === ".png" && buffer.length >= 24) {
    // PNG IHDR 块：宽在 offset 16-19, 高在 offset 20-23
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return { width, height };
  }

  if (ext === ".svg") {
    const text = buffer.toString("utf8", 0, Math.min(buffer.length, 2048));
    const widthMatch = text.match(/width=["'](\d+)(?:px)?["']/i);
    const heightMatch = text.match(/height=["'](\d+)(?:px)?["']/i);
    const width = widthMatch ? parseInt(widthMatch[1], 10) : 0;
    const height = heightMatch ? parseInt(heightMatch[1], 10) : 0;
    return { width, height };
  }

  return { width: 0, height: 0 };
};

export interface SyncLogosResult {
  totalFound: number;
  synced: number;
  skipped: number;
  orphaned: string[];
  oversized: string[];
}

/**
 * 同步本地图标目录到数据库 source_logos 表（幂等）
 */
export const syncLogos = async (): Promise<SyncLogosResult> => {
  if (!fs.existsSync(LOGOS_DIR) || !fs.statSync(LOGOS_DIR).isDirectory()) {
    logger.warn(`⚠️ [SyncLogos] 图标目录不存在: ${LOGOS_DIR}`);
    return { totalFound: 0, synced: 0, skipped: 0, orphaned: [], oversized: [] };
  }

  // 1. 获取 sources 表中所有已知 key
  const sourceRows = await queryRows("SELECT key FROM sources");
  const knownKeys = new Set(sourceRows.map((r: any) => String(r.key)));

  const files = fs.readdirSync(LOGOS_DIR).filter((f) => !f.startsWith("."));
  logger.info(`🖼️ [SyncLogos] 找到 ${files.length} 个图标文件，开始比对与同步...`);

  let synced = 0;
  let skipped = 0;
  const orphaned: string[] = [];
  const oversized: string[] = [];
  const now = new Date().toISOString();

  for (const file of files) {
    const filePath = path.join(LOGOS_DIR, file);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) continue;

    const ext = path.extname(file).toLowerCase();
    const mime = MIME_MAP[ext];
    if (!mime) {
      logger.warn(`⚠️ [SyncLogos] 不支持的文件扩展名: ${file}，已跳过`);
      skipped++;
      continue;
    }

    if (stat.size > MAX_LOGO_BYTES) {
      logger.warn(`⚠️ [SyncLogos] 文件过大 (${(stat.size / 1024).toFixed(1)}KB > 256KB): ${file}`);
      oversized.push(file);
      skipped++;
      continue;
    }

    const key = path.basename(file, ext);
    if (!knownKeys.has(key)) {
      logger.warn(`⚠️ [SyncLogos] 图标 key '${key}' 未收录在 sources 表中，跳过以避免孤立图片 (${file})`);
      orphaned.push(key);
      skipped++;
      continue;
    }

    try {
      const buffer = fs.readFileSync(filePath);
      const etag = crypto.createHash("md5").update(buffer).digest("hex");
      const { width, height } = parseImageDimensions(ext, buffer);

      // 写入或更新 source_logos
      await executeSql(
        `INSERT INTO source_logos (key, mime, bytes, width, height, source_file, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           mime = excluded.mime,
           bytes = excluded.bytes,
           width = excluded.width,
           height = excluded.height,
           source_file = excluded.source_file,
           updated_at = excluded.updated_at`,
        [key, mime, buffer, width, height, file, now],
      );

      // 回写 sources 标记与 etag
      await executeSql(
        `UPDATE sources SET has_logo = 1, logo_etag = ?, updated_at = ? WHERE key = ?`,
        [etag, now, key],
      );

      synced++;
    } catch (err) {
      logger.error(`❌ [SyncLogos] 同步失败 ${file}: ${err instanceof Error ? err.message : err}`);
      skipped++;
    }
  }

  logger.info(
    `✅ [SyncLogos] 同步完成！成功入库: ${synced} 张，跳过: ${skipped} 张 (孤立: ${orphaned.length}, 超限: ${oversized.length})`,
  );

  return {
    totalFound: files.length,
    synced,
    skipped,
    orphaned,
    oversized,
  };
};
