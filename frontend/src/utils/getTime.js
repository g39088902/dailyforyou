import LunarCalendar from "lunar-calendar";

export const formatTime = (timestamp) => {
  const date = new Date(timestamp);
  const now = new Date();
  const diffInSeconds = (now.getTime() - date.getTime()) / 1000;
  const diffInMinutes = diffInSeconds / 60;
  const diffInHours = diffInMinutes / 60;

  if (diffInSeconds < 60) {
    return "刚刚更新";
  } else if (diffInMinutes < 60) {
    const minutes = Math.floor(diffInMinutes);
    return `${minutes}分钟前更新`;
  } else if (diffInHours < 24) {
    const hours = Math.floor(diffInHours);
    return `${hours}小时前更新`;
  } else {
    const month = date.getMonth() + 1;
    const day = date.getDate();
    return `${month}月${day}日`;
  }
};

/**
 * 把后端下发的时间统一解析成毫秒时间戳。
 *
 * 两种来源必须都兼容：
 * - news_items.pub_time：毫秒 epoch 字符串，无值时为 ""，解析失败时为 "0"
 * - news_items.created_at：标准 ISO 字符串（带 T、带 Z、带毫秒）
 *
 * "0" 必须显式拒掉：new Date("0") 在 V8 里会解析成 2000-01-01，会显示成「26 年前」。
 */
export const parseTs = (value) => {
  if (value === null || value === undefined) return 0;
  const text = String(value).trim();
  if (!text || text === "0") return 0;

  // epoch 秒 / 毫秒字符串（适配器给的 timestamp 走这里）
  if (/^\d{10,13}$/.test(text)) {
    const num = Number(text);
    return text.length === 10 ? num * 1000 : num;
  }

  // 兼容 SQLite 风格的 "2026-11-02 09:00:00"（空格分隔、无时区）
  let normalized = text;
  if (!normalized.includes("T") && normalized.includes(" ")) {
    normalized = normalized.replace(" ", "T");
    if (!/([Zz]|[+-]\d{2}:?\d{2})$/.test(normalized)) normalized += "Z";
  }

  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? 0 : ms;
};

/**
 * 单条新闻的相对时间（不带「更新」二字，用于信息流条目）。
 * 时间点不可用时返回空串，交由调用方决定是否回退到其他字段。
 */
export const formatNewsAge = (timestamp, nowMs = Date.now()) => {
  const ms = parseTs(timestamp);
  if (!ms) return "";

  const diffMinutes = Math.floor(Math.max(0, nowMs - ms) / 60000);
  if (diffMinutes < 1) return "刚刚";
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} 小时前`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 8) return `${diffDays} 天前`;

  const date = new Date(ms);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
};

export const getCurrentTime = () => {
  const time = new Date();
  const year = time.getFullYear();
  const month =
    time.getMonth() + 1 < 10
      ? "0" + (time.getMonth() + 1)
      : time.getMonth() + 1;
  const day = time.getDate() < 10 ? "0" + time.getDate() : time.getDate();
  const hour = time.getHours() < 10 ? "0" + time.getHours() : time.getHours();
  const minute =
    time.getMinutes() < 10 ? "0" + time.getMinutes() : time.getMinutes();
  const second =
    time.getSeconds() < 10 ? "0" + time.getSeconds() : time.getSeconds();
  const weekday = [
    "星期日",
    "星期一",
    "星期二",
    "星期三",
    "星期四",
    "星期五",
    "星期六",
  ];
  // 获取农历
  const lunar = LunarCalendar.solarToLunar(
    time.getFullYear(),
    time.getMonth() + 1,
    time.getDate()
  );
  const currentTime = {
    time: {
      year,
      month,
      day,
      hour,
      minute,
      second,
      weekday: weekday[time.getDay()],
      text:
        year +
        "-" +
        month +
        "-" +
        day +
        " " +
        hour +
        ":" +
        minute +
        ":" +
        second,
    },
    lunar: {
      data: lunar,
      year: lunar.lunarYear,
      month: lunar.lunarMonthName,
      day: lunar.lunarDayName,
      GanZhiYear: lunar.GanZhiYear,
      GanZhiMonth: lunar.GanZhiMonth,
      GanZhiDay: lunar.GanZhiDay,
      text: lunar.lunarMonthName + lunar.lunarDayName,
    },
  };
  return currentTime;
};
