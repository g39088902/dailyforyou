import { parseTs } from "./getTime";

/**
 * 信源「停更」的两个展示阈值（小时）。
 *
 * 放在前端而不是后端：后端 /sources 带 ETag + max-age=60，ETag 只在爬虫写库时变，
 * 前端又只在启动时拉一次清单，所以后端不能下发算好的小时数（会被冻结最长 2 小时）。
 * 后端只给绝对时间 stats.lastItemAt，这里用当前时间现算。
 *
 * 注意：这两个阈值与后端 4 小时 stale 不是一回事。
 * stale 是「链路是否活着」（/health 在用），这里标记的是「内容是否还更新」。
 */
export const STALE_HOURS = 24;
export const DEAD_HOURS = 72;

const HOUR_MS = 3_600_000;

/**
 * 根据 stats.lastItemAt 派生信源健康度。
 *
 * level 取值：
 * - unknown：从未有过内容（新上线 / 永远空返回），不标记，避免误报成停更
 * - live：最近一条内容在 24h 内
 * - stale：24h ~ 72h 没有新内容
 * - dead：超过 72h 没有新内容
 *
 * lastItemAt 不能换成 lastSuccessAt：crawler 每轮都会把旧条目重新 upsert，
 * last_success_at 因此每 2 小时刷新一次，内容冻结三周的源也会显示「健康」。
 */
export const deriveSourceHealth = (stats, nowMs = Date.now()) => {
  const ms = parseTs(stats?.lastItemAt);
  if (!ms) {
    return { level: "unknown", hours: null, label: "" };
  }

  const hours = Math.max(0, (nowMs - ms) / HOUR_MS);

  if (hours >= DEAD_HOURS) {
    return { level: "dead", hours, label: `停更 ${Math.floor(hours / 24)} 天` };
  }
  if (hours >= STALE_HOURS) {
    return { level: "stale", hours, label: `停更 ${Math.floor(hours)} 小时` };
  }
  return { level: "live", hours, label: "" };
};
