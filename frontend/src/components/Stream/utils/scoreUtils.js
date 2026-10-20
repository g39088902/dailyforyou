// 根据分数段返回对应的视觉样式类名
export const getScoreClass = (score) => {
  if (score >= 90) return "score-l1";
  if (score >= 75) return "score-l2";
  if (score >= 60) return "score-l4";
  if (score >= 40) return "score-neutral";
  return "score-l5";
};

// 根据分数段推断对应的层级标签
export const getLayerByScore = (score) => {
  if (score >= 90) return "L1";
  if (score >= 75) return "L2";
  if (score >= 60) return "L4";
  if (score >= 40) return "Uncertain";
  return "L5";
};

// 评分胶囊悬浮提示信息
export const getScoreTooltip = (item) => {
  const parts = [];
  if (item._isUserModified) {
    parts.push("用户已手动修正评分");
  } else if (item._fromCache) {
    parts.push("AI评分来自SQLite缓存（直接复用历史评分）");
  } else {
    parts.push("AI实时计算评分");
  }
  parts.push("鼠标悬浮并拖动可手动修正分数");
  return parts.join(" · ");
};
