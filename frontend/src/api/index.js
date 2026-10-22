import axios from "@/api/request";

// 榜单与信源清单由后端服务（:6690）从数据库直接供给
export const FEED_BASE_URL =
  import.meta.env.VITE_FEED_API || import.meta.env.VITE_GLOBAL_API || "";

/**
 * 拼接后端下发的图标相对路径（如 /logo/xxx.png）为完整 URL
 * @param {string} logoPath
 * @returns {string}
 */
export const resolveLogoUrl = (logoPath) => {
  if (!logoPath) return "";
  if (/^https?:\/\//i.test(logoPath)) return logoPath;
  const base = String(FEED_BASE_URL || "").replace(/\/+$/, "");
  const path = logoPath.startsWith("/") ? logoPath : `/${logoPath}`;
  return `${base}${path}`;
};

/**
 * 获取后端动态信源清单与实时状态
 * @returns {Promise<{ code: number, initialized: boolean, etag: string, generatedAt: string, sources: Array }>}
 */
export const getSources = () => {
  return axios({
    method: "GET",
    url: "/sources",
    baseURL: FEED_BASE_URL,
    timeout: 15000,
    silentError: true,
  });
};

/**
 * 获取热榜分类数据（不再包含任何前缀字符串推断，直接使用清单下发的 name 与 params）
 * @param {string|object} sourceOrName 信源对象 { name, params } 或适配器名称字符串
 * @param {boolean} isNew 是否拉取最新数据
 * @param {object} extraParams 额外请求参数
 * @returns
 */
export const getHotLists = (sourceOrName, isNew = false, extraParams) => {
  const isObj = sourceOrName && typeof sourceOrName === "object";
  const name = isObj ? sourceOrName.name : sourceOrName;
  const params = isObj
    ? { ...(sourceOrName.params || {}), ...(extraParams || {}) }
    : extraParams || {};

  return axios({
    method: "GET",
    url: `/${name}`,
    baseURL: FEED_BASE_URL,
    silentError: true,
    params: {
      cache: !isNew,
      ...params,
    },
  });
};

/**
 * 个性化新闻喜好度预测评分接口
 * @param {object|Array} payload 单条新闻对象 { title, desc, source, text } 或批量数组 { items: [...], sort: true }
 * @param {boolean} isNew 是否跳过缓存重新评分
 * @returns
 */
export const scoreNews = (payload, isNew = false) => {
  const isBatch =
    Array.isArray(payload) ||
    Array.isArray(payload?.items) ||
    Array.isArray(payload?.texts) ||
    Array.isArray(payload?.data);

  if (!isBatch && payload && typeof payload === "object") {
    return axios({
      method: "GET",
      url: "/score",
      timeout: 60000,
      params: {
        cache: !isNew,
        title: payload.title || "",
        desc: typeof payload.desc === "string" ? payload.desc.slice(0, 500) : "",
        source: payload.source || "",
        text: payload.text || "",
      },
    });
  }

  return axios({
    method: "POST",
    url: "/score",
    timeout: 60000,
    params: {
      cache: !isNew,
    },
    data: Array.isArray(payload) ? { items: payload } : payload,
  });
};

/**
 * 批量仅查询 SQLite 已缓存的评分（毫秒级返回，不触发 AI 调用）
 * @param {Array} items 待查询的新闻数组 [{ title, desc, source }]
 * @returns
 */
export const queryCachedScoresBatch = (items = []) => {
  return axios({
    method: "POST",
    url: "/score/cache",
    timeout: 15000,
    silentError: true,
    data: { items },
  });
};

/**
 * 提交用户手动修正的新闻评分（存入 SQLite 供将来 AI 自动调整推荐逻辑使用）
 * @param {object|Array} payload 单条修正 { id, newsHash, title, desc, source, userScore, userLayer, userReason, reset } 或批量数组 { items: [...] }
 * @returns
 */
export const updateManualScore = (payload) => {
  return axios({
    method: "POST",
    url: "/score/manual",
    data: Array.isArray(payload) ? { items: payload } : payload,
  });
};

/**
 * 查询 SQLite 中存储的新闻评分记录（支持仅筛选用户手动修正过的记录）
 * @param {object} params { modified: true, source, limit, offset, page, pageSize, keyword }
 * @returns
 */
export const getScoreRecords = (params = {}) => {
  return axios({
    method: "GET",
    url: "/score/records",
    params,
  });
};

/**
 * 快捷查询当前用户手动修正过的新闻记录
 * @param {object} params { page, pageSize, keyword, source }
 */
export const getUserModifiedRecords = (params = {}) => {
  return axios({
    method: "GET",
    url: "/score/manual",
    params: {
      ...params,
      modified: true,
    },
  });
};

/**
 * 重置/撤销单条用户手动修正（恢复为 AI 原始打分）
 * @param {{ id?: number, newsHash?: string }} payload
 */
export const resetManualScore = (payload) => {
  return axios({
    method: "DELETE",
    url: "/score/manual",
    params: payload,
  });
};

/**
 * 标记或更新单条/批量新闻的已读状态（持久化存入 SQLite）
 * @param {object|Array} payload 单条 { newsHash, title, desc, source, url, isRead } 或批量数组 { items: [...], isRead }
 * @returns
 */
export const markNewsRead = (payload) => {
  return axios({
    method: "POST",
    url: "/score/read",
    data: Array.isArray(payload) ? { items: payload } : payload,
  });
};

/**
 * 获取后端 SQLite 中已标记为已读的新闻哈希列表
 * @param {number} limit
 * @returns
 */
export const getReadNewsHashes = (limit = 5000) => {
  return axios({
    method: "GET",
    url: "/score/read",
    params: { limit },
  });
};
