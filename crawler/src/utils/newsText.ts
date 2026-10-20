import crypto from "node:crypto";

/**
 * 去除简单 HTML 标签并清理多余空白
 */
export const cleanHtml = (input: string): string => {
  return input
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

/**
 * 计算新闻文本指纹（与评分侧保持同一算法，便于按哈希对照同一条新闻）
 */
export const hashNewsText = (text: string): string => {
  return crypto.createHash("md5").update(text).digest("hex");
};

export interface NewsTextInput {
  source?: string;
  title?: string;
  desc?: string;
}

export interface NewsTextResult {
  source: string;
  title: string;
  desc: string;
  formattedText: string;
  newsHash: string;
}

/**
 * 生成规范化的新闻正文与指纹
 * 结构：`【来源】…\n【标题】…\n【摘要】…`（摘要与标题相同则不重复）
 */
export const buildNewsText = (input: NewsTextInput): NewsTextResult => {
  const source = (input.source || "").trim();
  const title = input.title ? cleanHtml(input.title) : "";
  const desc = input.desc ? cleanHtml(input.desc.slice(0, 500)) : "";

  const parts: string[] = [];
  if (source) parts.push(`【来源】${source}`);
  if (title) parts.push(`【标题】${title}`);
  if (desc && desc !== title) parts.push(`【摘要】${desc}`);

  const formattedText = parts.join("\n");
  return {
    source,
    title,
    desc,
    formattedText,
    newsHash: formattedText ? hashNewsText(formattedText) : "",
  };
};
