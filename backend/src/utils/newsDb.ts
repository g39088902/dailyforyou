import logger from "./logger.js";
import { queryRows, queryOne, executeSql } from "../db/client.js";

export interface SourceMeta {
  sourceName: string;
  subType?: string;
  title: string;
  type: string;
  description?: string;
  link?: string;
}

/** 预置信源元数据字典 */
export const SOURCE_METADATA_MAP: Record<string, SourceMeta> = {
  bilibili: { sourceName: "bilibili", title: "哔哩哔哩", type: "热门视频", link: "https://www.bilibili.com" },
  douyin: { sourceName: "douyin", title: "抖音", type: "热搜榜", link: "https://www.douyin.com" },
  kuaishou: { sourceName: "kuaishou", title: "快手", type: "热榜", link: "https://www.kuaishou.com" },
  "36kr": { sourceName: "36kr", title: "36氪", type: "人气榜", link: "https://36kr.com" },
  sspai: { sourceName: "sspai", title: "少数派", type: "热门文章", link: "https://sspai.com" },
  ithome: { sourceName: "ithome", title: "IT之家", type: "日榜", link: "https://www.ithome.com" },
  thepaper: { sourceName: "thepaper", title: "澎湃新闻", type: "热榜", link: "https://www.thepaper.cn" },
  toutiao: { sourceName: "toutiao", title: "今日头条", type: "热榜", link: "https://www.toutiao.com" },
  juejin: { sourceName: "juejin", title: "稀土掘金", type: "综合榜", link: "https://juejin.cn" },
  "qq-news": { sourceName: "qq-news", title: "腾讯新闻", type: "热点精选", link: "https://news.qq.com" },
  cls: { sourceName: "cls", title: "财联社电报", type: "电报", link: "https://www.cls.cn/telegraph" },
  jiemian: { sourceName: "jiemian", title: "界面快报", type: "快报", link: "https://www.jiemian.com" },
  "jiemian:hot": { sourceName: "jiemian", subType: "hot", title: "界面热门", type: "热门", link: "https://www.jiemian.com" },
  "douban-group": { sourceName: "douban-group", title: "豆瓣讨论小组", type: "精选", link: "https://www.douban.com/group" },
  ngabbs: { sourceName: "ngabbs", title: "NGA", type: "热帖", link: "https://bbs.nga.cn" },
  hellogithub: { sourceName: "hellogithub", title: "HelloGitHub", type: "开源精选", link: "https://hellogithub.com" },
  github: { sourceName: "github", title: "GitHub", type: "Trending", link: "https://github.com/trending" },
  v2ex: { sourceName: "v2ex", title: "V2EX", type: "最热主题", link: "https://www.v2ex.com" },
  hackernews: { sourceName: "hackernews", title: "Hacker News", type: "Top", link: "https://news.ycombinator.com" },
  reuters: { sourceName: "reuters", title: "路透社·要闻", type: "要闻", link: "https://www.reuters.com" },
  "reuters:world": { sourceName: "reuters", subType: "world", title: "路透社·国际", type: "国际", link: "https://www.reuters.com/world" },
  "reuters:business": { sourceName: "reuters", subType: "business", title: "路透社·商业", type: "商业", link: "https://www.reuters.com/business" },
  "reuters:technology": { sourceName: "reuters", subType: "technology", title: "路透社·科技", type: "科技", link: "https://www.reuters.com/technology" },
  "reuters:markets": { sourceName: "reuters", subType: "markets", title: "路透社·金融", type: "金融", link: "https://www.reuters.com/markets" },
  "jin10:important": { sourceName: "jin10", subType: "important", title: "金十数据·要闻", type: "要闻", link: "https://www.jin10.com" },
  jin10: { sourceName: "jin10", title: "金十数据", type: "快讯", link: "https://flash.jin10.com" },
  "bloomberg:world": { sourceName: "bloomberg", subType: "world", title: "彭博社·全球", type: "全球头条", link: "https://www.bloomberg.com" },
  "bloomberg:markets": { sourceName: "bloomberg", subType: "markets", title: "彭博社·市场", type: "金融市场", link: "https://www.bloomberg.com/markets" },
  bloomberg: { sourceName: "bloomberg", title: "彭博社", type: "资讯", link: "https://www.bloomberg.com" },
  sina: { sourceName: "sina", title: "新浪网", type: "热榜", link: "https://news.sina.com.cn" },
  weibo: { sourceName: "weibo", title: "微博热搜", type: "热搜榜", link: "https://weibo.com" },
  zhihu: { sourceName: "zhihu", title: "知乎热榜", type: "热榜", link: "https://www.zhihu.com/hot" },
};

/** 历史中文标签到信源代号的平滑映射表（用于回填历史 5179 条旧记录） */
const LABEL_BACKFILL_MAP: Array<{ label: string; sourceName: string; subType: string }> = [
  { label: "路透社·要闻", sourceName: "reuters", subType: "" },
  { label: "路透社·国际", sourceName: "reuters", subType: "world" },
  { label: "路透社·商业", sourceName: "reuters", subType: "business" },
  { label: "路透社·金融", sourceName: "reuters", subType: "markets" },
  { label: "路透社·科技", sourceName: "reuters", subType: "technology" },
  { label: "彭博社·全球", sourceName: "bloomberg", subType: "world" },
  { label: "彭博社·市场", sourceName: "bloomberg", subType: "markets" },
  { label: "彭博社", sourceName: "bloomberg", subType: "" },
  { label: "快手", sourceName: "kuaishou", subType: "" },
  { label: "Hacker News", sourceName: "hackernews", subType: "" },
  { label: "今日头条", sourceName: "toutiao", subType: "" },
  { label: "财联社电报", sourceName: "cls", subType: "" },
  { label: "财联社", sourceName: "cls", subType: "" },
  { label: "腾讯新闻", sourceName: "qq-news", subType: "" },
  { label: "抖音", sourceName: "douyin", subType: "" },
  { label: "界面快报", sourceName: "jiemian", subType: "" },
  { label: "界面热门", sourceName: "jiemian", subType: "hot" },
  { label: "界面新闻", sourceName: "jiemian", subType: "" },
  { label: "NGA", sourceName: "ngabbs", subType: "" },
  { label: "36氪", sourceName: "36kr", subType: "" },
  { label: "澎湃新闻", sourceName: "thepaper", subType: "" },
  { label: "金十数据·要闻", sourceName: "jin10", subType: "important" },
  { label: "金十数据", sourceName: "jin10", subType: "" },
  { label: "IT之家", sourceName: "ithome", subType: "" },
  { label: "稀土掘金", sourceName: "juejin", subType: "" },
  { label: "哔哩哔哩", sourceName: "bilibili", subType: "" },
  { label: "豆瓣讨论小组", sourceName: "douban-group", subType: "" },
  { label: "豆瓣讨论", sourceName: "douban-group", subType: "" },
  { label: "少数派", sourceName: "sspai", subType: "" },
  { label: "V2EX", sourceName: "v2ex", subType: "" },
  { label: "GitHub", sourceName: "github", subType: "" },
  { label: "HelloGitHub", sourceName: "hellogithub", subType: "" },
  { label: "新浪网", sourceName: "sina", subType: "" },
  { label: "微博", sourceName: "weibo", subType: "" },
  { label: "知乎", sourceName: "zhihu", subType: "" },
];

/**
 * 启动时回填旧数据信源字段
 */
export const backfillOldNewsSources = async (): Promise<void> => {
  try {
    for (const item of LABEL_BACKFILL_MAP) {
      await executeSql(
        `UPDATE news_items
         SET source_name = ?, sub_type = ?
         WHERE source = ? AND (source_name = '' OR source_name IS NULL)`,
        [item.sourceName, item.subType, item.label],
      );
    }
    logger.info(`✨ [NewsDb] 历史新闻信源映射回填检查完毕`);
  } catch (err) {
    logger.error(
      `⚠️ [NewsDb] 回填历史信源异常: ${err instanceof Error ? err.message : err}`,
    );
  }
};

export interface NewsQueryOptions {
  subType?: string;
  limit?: number;
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
}

export interface NewsListResult {
  name: string;
  title: string;
  type: string;
  description?: string;
  link?: string;
  total: number;
  updateTime: string;
  data: NewsItemResult[];
}

/**
 * 按信源代号和子分类查询新闻列表（直接从 news_items 表读取）
 */
export const queryNewsBySource = async (
  sourceName: string,
  options: NewsQueryOptions = {},
): Promise<NewsListResult> => {
  const subType = options.subType || "";
  const limit = Math.min(Math.max(1, options.limit || 30), 100);

  const metaKey = subType ? `${sourceName}:${subType}` : sourceName;
  const meta: SourceMeta = SOURCE_METADATA_MAP[metaKey] ||
    SOURCE_METADATA_MAP[sourceName] || {
      sourceName,
      subType,
      title: sourceName,
      type: "热榜",
    };

  // 优先按 source_name + sub_type 查询；若为默认分类，兼容匹配 sub_type 为空或不传
  let sql = `
    SELECT id, news_hash, source, source_name, sub_type, title, desc_text, url, mobile_url, hot, cover, pub_time, created_at
    FROM news_items
    WHERE (source_name = ? AND sub_type = ?)
  `;
  const args: any[] = [sourceName, subType];

  // 如果 subType 为空，补充兼容旧 source 标签查询
  if (!subType && meta.title) {
    sql += ` OR (source = ? AND (source_name = '' OR source_name IS NULL))`;
    args.push(meta.title);
  }

  sql += ` ORDER BY id DESC LIMIT ?`;
  args.push(limit);

  const rows = await queryRows(sql, args);

  const updateTime =
    rows.length > 0 && rows[0].created_at
      ? rows[0].created_at
      : new Date().toISOString();

  const data: NewsItemResult[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    desc: r.desc_text || "",
    cover: r.cover || undefined,
    hot: r.hot || undefined,
    url: r.url,
    mobileUrl: r.mobile_url || r.url,
    timestamp: r.pub_time || r.created_at,
  }));

  return {
    name: sourceName,
    title: meta.title,
    type: meta.type,
    description: meta.description || "",
    link: meta.link || "",
    total: data.length,
    updateTime,
    data,
  };
};
