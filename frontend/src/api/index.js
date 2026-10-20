import axios from "@/api/request";

/**
 * 获取热榜分类数据
 * @param {string} type 热榜分类名称
 * @param {boolean} isNew 是否拉取最新数据
 * @param {object} params 请求参数
 * @returns
 */
export const getHotLists = (type, isNew = false, params) => {
  const path = type.startsWith("cls-")
    ? "cls"
    : type.startsWith("jiemian-")
    ? "jiemian"
    : type.startsWith("reuters-")
    ? "reuters"
    : type.startsWith("jin10-")
    ? "jin10"
    : type.startsWith("bloomberg-")
    ? "bloomberg"
    : type;
  return axios({
    method: "GET",
    url: `/${path}`,
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
 * @param {object} params { modified: true, source, limit, offset }
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
