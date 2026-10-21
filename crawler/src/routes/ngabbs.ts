import axios from "axios";
import iconv from "iconv-lite";
import type { ListItem, RouterData, ListContext } from "../types.js";
import logger from "../utils/logger.js";
import { config } from "../config.js";

const unescapeHtml = (str: string): string => {
  if (!str) return "";
  return str
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
    .trim();
};

const getList = async () => {
  const url = "https://bbs.nga.cn/thread.php?recommend=1&__output=11";
  const res = await axios.post<ArrayBuffer>(url, null, {
    responseType: "arraybuffer",
    headers: {
      "User-Agent": "NGA_WP_JW",
      "X-User-Agent": "NGA_WP_JW",
    },
    timeout: config.REQUEST_TIMEOUT || 8000,
  });

  const text = iconv.decode(Buffer.from(res.data), "gbk");
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`NGA 数据解析 JSON 失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  const rawThreads = parsed?.data?.__T || [];
  const threadList: any[] = Array.isArray(rawThreads)
    ? rawThreads
    : Object.values(rawThreads || {});

  const listData: ListItem[] = [];
  for (const t of threadList) {
    const rawSubject = String(t.subject || "").trim();
    if (!rawSubject || rawSubject === "访客不能直接访问") continue;

    const tid = String(t.tid || "");
    if (!tid) continue;

    const replies = typeof t.replies === "number" ? t.replies : parseInt(String(t.replies || 0), 10);
    const recommend = typeof t.recommend === "number" ? t.recommend : parseInt(String(t.recommend || 0), 10);
    const postdate = typeof t.postdate === "number" ? t.postdate : parseInt(String(t.postdate || 0), 10);

    listData.push({
      id: tid,
      title: unescapeHtml(rawSubject),
      author: String(t.author || "").trim() || undefined,
      hot: replies > 0 ? replies : recommend,
      timestamp: postdate > 0 ? postdate * 1000 : undefined,
      url: `https://bbs.nga.cn/read.php?tid=${tid}`,
      mobileUrl: `https://bbs.nga.cn/read.php?tid=${tid}`,
    });
  }

  const updateTime = new Date().toISOString();

  return {
    fromCache: false,
    updateTime,
    data: listData,
  };
};

export const handleRoute = async (_: ListContext, _noCache: boolean): Promise<RouterData> => {
  const listData = await getList();
  const routeData: RouterData = {
    name: "ngabbs",
    title: "NGA",
    type: "热帖",
    description: "艾泽拉斯国家地理 - 精英玩家社区",
    link: "https://bbs.nga.cn/",
    total: listData.data?.length || 0,
    ...listData,
  };
  return routeData;
};
