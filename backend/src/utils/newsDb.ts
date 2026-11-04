import crypto from "node:crypto";
import logger from "./logger.js";
import { config } from "../config.js";
import { queryRows, queryOne } from "../db/client.js";

export const EXPECTED_NEWS_SCHEMA = 3;

const CACHE_TTL_MS = 60_000;

export interface SourceStats {
  total: number;
  lastSuccessAt: string;
  /**
   * 最近一次「抓到新条目」的入库时间：MAX(news_items.created_at)。
   * 空串表示该信源从未有过内容。它是内容新鲜度的唯一依据——
   * last_success_at 只反映「本轮能抓到数据」，旧条目每轮都会被 upsert 命中，无法判断停更。
   */
  lastItemAt: string;
  stale: boolean;
  status: string;
  consecutiveFailures: number;
  lastError: string;
}

export interface SourceItemDto {
  key: string;
  name: string;
  params: Record<string, any>;
  label: string;
  category: string;
  type: string;
  link: string;
  logo: string;
  logoText: string;
  logoColor: string;
  order: number;
  defaultOn: boolean;
  enabled: boolean;
  stats: SourceStats;
}

interface RawSourceRow {
  key: string;
  name: string;
  sub_type: string;
  params_json: string;
  label: string;
  category: string;
  type: string;
  link: string;
  logo_url: string;
  logo_text: string;
  logo_color: string;
  has_logo: number;
  logo_etag: string;
  sort_order: number;
  default_on: number;
  enabled: number;
  retired: number;
  status: string;
  last_started_at: string;
  last_finished_at: string;
  last_success_at: string;
  last_error: string;
  items_total: number;
  items_last_run: number;
  consecutive_failures: number;
  updated_at: string;
}

interface SourcesCacheEntry {
  initialized: boolean;
  rows: RawSourceRow[];
  /** `${name}\u0000${sub_type}` -> MAX(created_at)，与 rows 共用同一份 60s 缓存 */
  lastItemMap: Map<string, string>;
  etag: string;
  generatedAt: string;
  expiresAt: number;
}

interface LogoCacheEntry {
  mime: string;
  bytes: Buffer;
  etag: string;
}

let sourcesCache: SourcesCacheEntry | null = null;
let logosCacheMap: Map<string, LogoCacheEntry> = new Map();
let logosCacheExpiresAt = 0;

const md5 = (input: string | Buffer): string =>
  crypto.createHash("md5").update(input).digest("hex");

const isNoSuchTableError = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err);
  return /no such table/i.test(msg);
};

/**
 * 转换任意 SQLite/libSQL BLOB 返回值为 Node Buffer
 */
const toBuffer = (val: unknown): Buffer => {
  if (!val) return Buffer.alloc(0);
  if (Buffer.isBuffer(val)) return val;
  if (val instanceof Uint8Array) return Buffer.from(val);
  if (val instanceof ArrayBuffer) return Buffer.from(val);
  if (typeof val === "string") return Buffer.from(val, "base64");
  return Buffer.from(val as any);
};

/**
 * 启动时检查 schema_meta 版本握手与预热图标缓存（不阻塞启动，不写爬虫表）
 */
export const initNewsDb = async (): Promise<void> => {
  try {
    const row = await queryOne(
      `SELECT value FROM schema_meta WHERE key = 'news_schema_version'`,
    );
    const actual = row ? parseInt(String(row.value), 10) : 0;
    if (actual !== EXPECTED_NEWS_SCHEMA) {
      logger.warn(
        `⚠️ [NewsDb] schema_meta.news_schema_version 期望 ${EXPECTED_NEWS_SCHEMA}，实际 ${actual || "未设置"}`,
      );
    } else {
      logger.info(`✨ [NewsDb] schema_meta 版本校验通过 (v${actual})`);
    }
  } catch (err) {
    if (isNoSuchTableError(err)) {
      logger.warn(`⚠️ [NewsDb] schema_meta 表尚未创建（等待爬虫初始化）`);
    } else {
      logger.warn(
        `⚠️ [NewsDb] 读取 schema_meta 异常: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // 预热清单与图标内存缓存
  await loadSourcesWithCache(true);
  await loadLogosWithCache(true);
};

/**
 * 兼容旧入口调用（严守契约：backend 不再对 news_items 执行 UPDATE）
 */
export const backfillOldNewsSources = async (): Promise<void> => {
  await initNewsDb();
};

/**
 * 每个信源「最近一次抓到新条目」的入库时间：MAX(news_items.created_at)。
 *
 * 为什么不用 sources.last_success_at：crawler 每轮先释放本 route 的标题占用，
 * 同一批旧条目会被重新 upsert 命中，written > 0 恒成立，last_success_at 每轮都刷新。
 * 它只证明「链路活着」，不能判断内容是否冻结。created_at 只在首次 INSERT 写入、
 * 冲突更新不覆盖，才是真正的「内容新鲜度」。
 *
 * 键兼容历史行：source_name 为空时退化成 source（与列表查询的 legacy OR 分支持平）。
 * news_items 不存在（backend 先于 crawler 部署）时返回空 Map，不能拖垮 /sources。
 */
const loadLastItemMap = async (): Promise<Map<string, string>> => {
  try {
    const rows = await queryRows(
      `SELECT COALESCE(NULLIF(source_name, ''), source) AS gkey,
              sub_type AS gsub,
              MAX(created_at) AS latest
       FROM news_items
       GROUP BY gkey, gsub`,
    );
    const map = new Map<string, string>();
    for (const r of rows) {
      const latest = String(r.latest ?? "");
      if (!latest) continue;
      map.set(`${String(r.gkey ?? "")}\u0000${String(r.gsub ?? "")}`, latest);
    }
    return map;
  } catch (err) {
    if (!isNoSuchTableError(err)) {
      logger.warn(
        `⚠️ [NewsDb] 聚合信源最近内容时间失败: ${err instanceof Error ? err.message : err}`,
      );
    }
    return new Map();
  }
};

/**
 * 读取并缓存 sources 表（60s TTL）
 */
const loadSourcesWithCache = async (
  force = false,
): Promise<SourcesCacheEntry> => {
  const now = Date.now();
  if (!force && sourcesCache && sourcesCache.expiresAt > now) {
    return sourcesCache;
  }

  try {
    // 两条查询并行：信源清单与「最近内容时间」聚合共用同一份 60s 缓存条目，
    // 这样 /sources 与 /health 都不会因为多一次聚合而被拖慢。
    const [rows, lastItemMap] = await Promise.all([
      queryRows(
        `SELECT
           key, name, sub_type, params_json, label, category, type, link,
           logo_url, logo_text, logo_color, has_logo, logo_etag,
           sort_order, default_on, enabled, retired,
           status, last_started_at, last_finished_at, last_success_at, last_error,
           items_total, items_last_run, consecutive_failures, updated_at
         FROM sources
         WHERE retired = 0
         ORDER BY sort_order ASC, key ASC`,
      ) as Promise<RawSourceRow[]>,
      loadLastItemMap(),
    ]);

    if (!rows || rows.length === 0) {
      const emptyEntry: SourcesCacheEntry = {
        initialized: false,
        rows: [],
        lastItemMap,
        etag: "src-empty",
        generatedAt: new Date(now).toISOString(),
        expiresAt: now + 5_000, // 空表时短缓存，以便爬虫刚写入后快速感知
      };
      sourcesCache = emptyEntry;
      return emptyEntry;
    }

    let maxUpdatedAt = "";
    for (const r of rows) {
      if (r.updated_at && r.updated_at > maxUpdatedAt) {
        maxUpdatedAt = r.updated_at;
      }
    }
    const etag = `src-${md5(`${maxUpdatedAt}:${rows.length}`).slice(0, 12)}`;

    const entry: SourcesCacheEntry = {
      initialized: true,
      rows,
      lastItemMap,
      etag,
      generatedAt: new Date(now).toISOString(),
      expiresAt: now + CACHE_TTL_MS,
    };
    sourcesCache = entry;
    return entry;
  } catch (err) {
    if (isNoSuchTableError(err)) {
      const uninitEntry: SourcesCacheEntry = {
        initialized: false,
        rows: [],
        lastItemMap: new Map(),
        etag: "src-uninit",
        generatedAt: new Date(now).toISOString(),
        expiresAt: now + 5_000,
      };
      sourcesCache = uninitEntry;
      return uninitEntry;
    }
    throw err;
  }
};

/**
 * 读取并缓存 source_logos 全表到内存 Map（60s TTL）
 */
const loadLogosWithCache = async (
  force = false,
): Promise<Map<string, LogoCacheEntry>> => {
  const now = Date.now();
  if (!force && logosCacheExpiresAt > now && logosCacheMap.size > 0) {
    return logosCacheMap;
  }

  try {
    const rows = await queryRows(
      `SELECT l.key, l.mime, l.bytes, s.logo_etag
       FROM source_logos l
       LEFT JOIN sources s ON s.key = l.key`,
    );

    const nextMap = new Map<string, LogoCacheEntry>();
    for (const r of rows) {
      const buf = toBuffer(r.bytes);
      if (buf.length > 0) {
        const etag = r.logo_etag || md5(buf).slice(0, 16);
        nextMap.set(String(r.key), {
          mime: String(r.mime || "image/png"),
          bytes: buf,
          etag: String(etag),
        });
      }
    }
    logosCacheMap = nextMap;
    logosCacheExpiresAt = now + CACHE_TTL_MS;
    return logosCacheMap;
  } catch (err) {
    if (isNoSuchTableError(err)) {
      logosCacheMap = new Map();
      logosCacheExpiresAt = now + 5_000;
      return logosCacheMap;
    }
    logger.warn(
      `⚠️ [NewsDb] 加载 source_logos 缓存失败: ${err instanceof Error ? err.message : err}`,
    );
    return logosCacheMap;
  }
};

/**
 * 计算单行信源的运行时状态与 DTO
 */
const toSourceItemDto = (
  row: RawSourceRow,
  nowMs: number,
  lastItemMap: Map<string, string> = new Map(),
): SourceItemDto => {
  const crawlIntervalMs = (config.CRAWL_INTERVAL_MINUTES || 120) * 60_000;
  const staleThresholdMs = 2 * crawlIntervalMs;
  const stuckThresholdMs = 30 * 60_000;

  let params: Record<string, any> = {};
  if (row.params_json) {
    try {
      const parsed = JSON.parse(row.params_json);
      if (parsed && typeof parsed === "object") {
        params = parsed;
      }
    } catch {
      params = {};
    }
  }

  const lastSuccessMs = row.last_success_at ? Date.parse(row.last_success_at) : 0;
  const stale =
    !lastSuccessMs ||
    Number.isNaN(lastSuccessMs) ||
    nowMs - lastSuccessMs > staleThresholdMs;

  let status = row.status || "idle";
  if (status === "running") {
    const startedMs = row.last_started_at ? Date.parse(row.last_started_at) : 0;
    if (!startedMs || Number.isNaN(startedMs) || nowMs - startedMs > stuckThresholdMs) {
      status = "stuck";
    }
  }

  const consecutiveFailures = Number(row.consecutive_failures ?? 0);
  const enabled =
    Number(row.enabled) === 1 &&
    Number(row.retired) === 0 &&
    consecutiveFailures < 5;

  const logo =
    row.logo_url && row.logo_url.trim()
      ? row.logo_url.trim()
      : `/logo/${row.key}.png`;

  // 现代表按 name|sub_type 命中；历史行（source_name 为空、靠 source=label 兜底）再查一次
  const subType = String(row.sub_type || "");
  const lastItemAt =
    lastItemMap.get(`${row.name}\u0000${subType}`) ||
    lastItemMap.get(`${row.label}\u0000${subType}`) ||
    "";

  return {
    key: String(row.key),
    name: String(row.name),
    params,
    label: String(row.label),
    category: String(row.category || ""),
    type: String(row.type || ""),
    link: String(row.link || ""),
    logo,
    logoText: String(row.logo_text || row.label?.slice(0, 1) || ""),
    logoColor: String(row.logo_color || "#5F5E5A"),
    order: Number(row.sort_order ?? 0),
    defaultOn: Number(row.default_on ?? 1) === 1,
    enabled,
    stats: {
      total: Number(row.items_total ?? 0),
      lastSuccessAt: String(row.last_success_at || ""),
      lastItemAt,
      stale,
      status,
      consecutiveFailures,
      lastError: String(row.last_error || ""),
    },
  };
};

/**
 * GET /sources 数据供给
 */
export const getSourcesManifest = async (): Promise<{
  initialized: boolean;
  etag: string;
  generatedAt: string;
  sources: SourceItemDto[];
}> => {
  const entry = await loadSourcesWithCache();
  if (!entry.initialized) {
    return {
      initialized: false,
      etag: entry.etag,
      generatedAt: entry.generatedAt,
      sources: [],
    };
  }

  const nowMs = Date.now();
  const sources = entry.rows.map((r) => toSourceItemDto(r, nowMs, entry.lastItemMap));

  return {
    initialized: true,
    etag: entry.etag,
    generatedAt: entry.generatedAt,
    sources,
  };
};

const escapeXml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );

export type LogoResolution =
  | { type: "not_found" }
  | { type: "redirect"; url: string; etag: string }
  | { type: "blob"; mime: string; bytes: Buffer; etag: string }
  | { type: "badge"; mime: string; svg: string; etag: string };

/**
 * GET /logo/:file 三级降级解析
 */
export const resolveSourceLogo = async (key: string): Promise<LogoResolution> => {
  const entry = await loadSourcesWithCache();
  const sourceRow = entry.rows.find(
    (r) => r.key === key && Number(r.retired) === 0,
  );

  // 守门：key 不在 sources（或 retired = 1）-> 404
  if (!sourceRow) {
    return { type: "not_found" };
  }

  // 1. logo_url 非空 -> 302 跳转
  if (sourceRow.logo_url && sourceRow.logo_url.trim()) {
    const url = sourceRow.logo_url.trim();
    return {
      type: "redirect",
      url,
      etag: md5(url).slice(0, 16),
    };
  }

  // 2. source_logos 命中 -> 200 + bytes
  const logosMap = await loadLogosWithCache();
  const blobEntry = logosMap.get(key);
  if (blobEntry && blobEntry.bytes.length > 0) {
    return {
      type: "blob",
      mime: blobEntry.mime,
      bytes: blobEntry.bytes,
      etag: blobEntry.etag,
    };
  }

  // 3. 否则 -> 200 + 动态 SVG 文字徽标
  const text = (sourceRow.logo_text || sourceRow.label || key).slice(0, 2);
  const color = sourceRow.logo_color || "#5F5E5A";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="${escapeXml(color)}"/>
  <text x="32" y="34" dominant-baseline="central" text-anchor="middle" font-family="sans-serif" font-size="28" font-weight="bold" fill="#fff">${escapeXml(text)}</text>
</svg>`;
  const etag = `badge-${md5(`${text}:${color}`).slice(0, 16)}`;

  return {
    type: "badge",
    mime: "image/svg+xml",
    svg,
    etag,
  };
};

/**
 * GET /health 状态聚合
 */
export const getHealthStatus = async () => {
  const startMs = Date.now();
  let dbOk = false;
  let actualSchema = 0;

  try {
    await queryOne(`SELECT 1 AS ok`);
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const latencyMs = Date.now() - startMs;

  if (!dbOk) {
    return {
      code: 200,
      status: "down" as const,
      db: { ok: false, latencyMs },
      sources: { total: 0, stale: 0, failed: 0 },
      crawler: { lastStartedAt: "", lagMinutes: -1 },
      schema: { expected: EXPECTED_NEWS_SCHEMA, actual: 0 },
    };
  }

  try {
    const schemaRow = await queryOne(
      `SELECT value FROM schema_meta WHERE key = 'news_schema_version'`,
    );
    if (schemaRow && schemaRow.value !== undefined) {
      actualSchema = parseInt(String(schemaRow.value), 10) || 0;
    }
  } catch {
    actualSchema = 0;
  }

  const manifest = await getSourcesManifest();
  const total = manifest.sources.length;
  let staleCount = 0;
  let failedCount = 0;
  let latestStartedAt = "";

  for (const r of sourcesCache?.rows || []) {
    if (r.last_started_at && r.last_started_at > latestStartedAt) {
      latestStartedAt = r.last_started_at;
    }
    if (r.last_success_at && r.last_success_at > latestStartedAt) {
      latestStartedAt = r.last_success_at;
    }
  }

  for (const s of manifest.sources) {
    if (s.stats.stale) staleCount++;
    if (s.stats.status === "failed" || s.stats.status === "stuck") {
      failedCount++;
    }
  }

  const nowMs = Date.now();
  const lastStartedMs = latestStartedAt ? Date.parse(latestStartedAt) : 0;
  const lagMinutes =
    lastStartedMs && !Number.isNaN(lastStartedMs)
      ? Math.max(0, Math.round((nowMs - lastStartedMs) / 60_000))
      : 999999;

  const crawlInterval = config.CRAWL_INTERVAL_MINUTES || 120;
  let status: "ok" | "degraded" | "down" = "ok";

  if (!manifest.initialized || lagMinutes > 6 * crawlInterval) {
    status = "down";
  } else if (
    lagMinutes > 2 * crawlInterval ||
    actualSchema !== EXPECTED_NEWS_SCHEMA
  ) {
    status = "degraded";
  }

  return {
    code: 200,
    status,
    db: { ok: true, latencyMs },
    sources: { total, stale: staleCount, failed: failedCount },
    crawler: { lastStartedAt: latestStartedAt, lagMinutes },
    schema: { expected: EXPECTED_NEWS_SCHEMA, actual: actualSchema },
  };
};

export interface NewsQueryOptions {
  subType?: string;
  limit?: number;
  /**
   * 可见窗口（小时）。undefined = 用 config.NEWS_MAX_AGE_HOURS，0 = 不限。
   * 口径是 news_items.created_at（首次入库），不是上游 pub_time。
   */
  maxAgeHours?: number;
}

export interface NewsItemResult {
  id: number;
  title: string;
  desc: string;
  cover?: string;
  hot?: string;
  url: string;
  mobileUrl: string;
  timestamp?: string;
  /** 首次入库时间（ISO），用于展示内容新旧 */
  createdAt: string;
}

export interface NewsListResult {
  key: string;
  name: string;
  title: string;
  type: string;
  description?: string;
  link?: string;
  total: number;
  /** 本次生效的可见窗口（小时），0 = 不限 */
  maxAgeHours: number;
  /** 窗口内没有条目、但库里还有更早内容（前端据此给出「查看更早内容」入口） */
  hasOlder: boolean;
  /** 该信源最近一条内容的入库时间；空串 = 从未有内容 */
  lastItemAt: string;
  stale: boolean;
  updateTime: string;
  data: NewsItemResult[];
}

export class UnknownSourceError extends Error {
  constructor(sourceName: string, subType = "") {
    super(`unknown source: ${sourceName}${subType ? ` (${subType})` : ""}`);
    this.name = "UnknownSourceError";
  }
}

/**
 * 按信源代号和子分类查询新闻列表（先在 sources 表核验，未知信源抛 UnknownSourceError -> 404）
 */
export const queryNewsBySource = async (
  sourceName: string,
  options: NewsQueryOptions = {},
): Promise<NewsListResult> => {
  const subType = options.subType || "";
  const limit = Math.min(Math.max(1, options.limit || 30), 100);

  // undefined 与 0 必须区分：未传参走配置默认，显式传 0 才表示「不限」
  const rawMaxAge = options.maxAgeHours;
  const maxAgeHours =
    typeof rawMaxAge === "number" && Number.isFinite(rawMaxAge) && rawMaxAge >= 0
      ? Math.floor(rawMaxAge)
      : config.NEWS_MAX_AGE_HOURS || 0;
  const limitByAge = maxAgeHours > 0;
  const cutoff = limitByAge
    ? new Date(Date.now() - maxAgeHours * 3_600_000).toISOString()
    : "";

  const entry = await loadSourcesWithCache();
  // 在 sources 清单中查找匹配的活跃信源
  let matchedRow = entry.rows.find(
    (r) =>
      r.name === sourceName &&
      (r.sub_type || "") === subType &&
      Number(r.retired) === 0,
  );

  // 如果未传 subType，且该 name 在库中只有一个默认子类型（比如部分只注册了单一子类型的源），允许按 key 或唯一 name 匹配
  if (!matchedRow && !subType) {
    matchedRow = entry.rows.find(
      (r) => r.key === sourceName && Number(r.retired) === 0,
    );
  }

  if (!matchedRow) {
    throw new UnknownSourceError(sourceName, subType);
  }

  const dto = toSourceItemDto(matchedRow, Date.now(), entry.lastItemMap);
  const effectiveName = matchedRow.name;
  const effectiveSubType = matchedRow.sub_type || "";

  // 信源条件必须整体加括号：SQL 里 AND 优先级高于 OR。
  // 若写成 `WHERE (A) OR (B) AND created_at >= ?`，实际等价于 `A OR (B AND created_at)`，
  // 第一个分支（正常数据）完全不过滤 —— 时间窗会静默失效。
  const scopeParts = ["(source_name = ? AND sub_type = ?)"];
  const scopeArgs: any[] = [effectiveName, effectiveSubType];
  if (!effectiveSubType && matchedRow.label) {
    scopeParts.push("(source = ? AND (source_name = '' OR source_name IS NULL))");
    scopeArgs.push(matchedRow.label);
  }
  const scopeSql = `(${scopeParts.join(" OR ")})`;

  let sql = `
    SELECT id, news_hash, source, source_name, sub_type, title, desc_text, url, mobile_url, hot, cover, pub_time, created_at
    FROM news_items
    WHERE ${scopeSql}
  `;
  const args: any[] = [...scopeArgs];

  if (limitByAge) {
    sql += ` AND created_at >= ?`;
    args.push(cutoff);
  }

  sql += ` ORDER BY id DESC LIMIT ?`;
  args.push(limit);

  const rows = await queryRows(sql, args);

  // 窗口内为空时补一次存在性探测，避免给出一个点了没反应的「查看更早内容」按钮。
  // 只在空频道上执行，代价可忽略；不能用 items_total 推导，会漏算 source_name 为空的历史行。
  let hasOlder = false;
  if (limitByAge && rows.length === 0) {
    const older = await queryOne(
      `SELECT 1 AS x FROM news_items WHERE ${scopeSql} AND created_at < ? LIMIT 1`,
      [...scopeArgs, cutoff],
    );
    hasOlder = Boolean(older);
  }

  // 最近内容时间取「聚合值」与「首行 created_at」的较新者：
  // 聚合值来自 60s 缓存，刚入库的条目可能还没进缓存；首行则受 ORDER BY id DESC 约束，
  // 只有在 created_at 与 id 同向单调时才等于最大值，不能单独依赖它。
  // 两者都是同格式 ISO 字符串，字典序即时间序。
  const rowLast = rows.length > 0 ? String(rows[0].created_at || "") : "";
  const mapLast = dto.stats.lastItemAt || "";
  const lastItemAt = rowLast > mapLast ? rowLast : mapLast;

  // updateTime 的口径是「这个频道最近一条内容的入库时间」。
  // 不能回退到 last_success_at：旧条目每轮都会被 upsert 命中并刷新它，
  // 会造成「页头显示 3 小时前更新、列表却全空」的经典坏页面。
  const updateTime =
    lastItemAt || matchedRow.last_success_at || new Date().toISOString();

  const data: NewsItemResult[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    desc: r.desc_text || "",
    cover: r.cover || undefined,
    hot: r.hot || undefined,
    url: r.url,
    mobileUrl: r.mobile_url || r.url,
    timestamp: r.pub_time || r.created_at,
    createdAt: String(r.created_at || ""),
  }));

  return {
    key: dto.key,
    name: effectiveName,
    title: dto.label,
    type: dto.type,
    description: "",
    link: dto.link,
    total: data.length,
    maxAgeHours,
    hasOlder,
    lastItemAt,
    stale: dto.stats.stale,
    updateTime,
    data,
  };
};
