<template>
  <n-popover
    trigger="hover"
    placement="bottom"
    :show-arrow="false"
    :raw="true"
    :duration="150"
  >
    <template #trigger>
      <div
        :class="[
          'stream-clock-capsule',
          {
            'is-compact': compact,
            'is-stream-route': isStreamRoute,
          },
        ]"
      >
        <!-- 紧凑单行模式（用于滚动吸顶或移动端） -->
        <div class="compact-view">
          <span class="live-dot-wrap" title="实时时钟同步中">
            <span class="live-pulse" />
            <span class="live-dot" />
          </span>
          <span class="compact-time">
            {{ clockData.hours }}<span class="colon">:</span>{{ clockData.minutes }}<span class="colon">:</span>{{ clockData.seconds }}
          </span>
          <span class="compact-divider">·</span>
          <span class="compact-date">
            {{ clockData.month }}.{{ clockData.day }} {{ clockData.weekdayShort }}
          </span>
        </div>

        <!-- 默认高能情报终端全景模式 -->
        <div class="full-view">
          <!-- 顶栏：实时指示灯与时区标记 -->
          <div class="capsule-header">
            <div class="live-status">
              <span class="live-pulse" />
              <span class="live-dot" />
              <span class="live-text">{{ isStreamRoute ? 'LIVE 实时情报' : 'LIVE 实时' }}</span>
            </div>
            <span class="timezone-badge">UTC+8</span>
          </div>

          <!-- 中行：数码时钟核心（等宽无抖动字体 + 柔和呼吸冒号 + 精确秒数） -->
          <div class="capsule-time">
            <span class="hour-min">{{ clockData.hours }}<span class="colon">:</span>{{ clockData.minutes }}</span>
            <span class="second-group">
              <span class="second-dot">:</span>
              <span class="second-num">{{ clockData.seconds }}</span>
            </span>
          </div>

          <!-- 底栏：公历日期 · 星期 · 农历干支历法 -->
          <div class="capsule-footer">
            <span class="date-text">{{ clockData.month }}月{{ clockData.day }}日</span>
            <span class="footer-dot">·</span>
            <span class="weekday-text">{{ clockData.weekdayShort }}</span>
            <template v-if="clockData.lunarText">
              <span class="footer-dot">·</span>
              <span class="lunar-text">{{ clockData.lunarGanZhi }} {{ clockData.lunarText }}</span>
            </template>
          </div>
        </div>
      </div>
    </template>

    <!-- 悬浮弹出的“情报中枢时间同步面板” (Telemetry & Timezone Control) -->
    <div class="telemetry-popover-card">
      <!-- 头部：系统时间源状态 -->
      <div class="popover-header">
        <div class="header-title">
          <n-icon :component="Time" size="16" class="title-icon" />
          <span>情报中枢时间源 (Telemetry)</span>
        </div>
        <n-tag size="tiny" round type="success" :bordered="false" class="status-tag">
          <template #icon>
            <span class="popover-live-dot" />
          </template>
          心跳同步正常
        </n-tag>
      </div>

      <!-- 全球主要金融与科技交易中心时区对照 -->
      <div class="popover-section">
        <div class="section-label">全球核心市场对照</div>
        <div class="tz-grid">
          <div class="tz-item active">
            <div class="tz-name">
              <span class="tz-flag">🇨🇳</span>
              <span>北京时间 (CST)</span>
            </div>
            <div class="tz-time">{{ clockData.beijingTime }}</div>
          </div>

          <div class="tz-item">
            <div class="tz-name">
              <span class="tz-flag">🌐</span>
              <span>世界协调时 (UTC)</span>
            </div>
            <div class="tz-time">{{ clockData.utcTime }}</div>
          </div>

          <div class="tz-item">
            <div class="tz-name">
              <span class="tz-flag">🇺🇸</span>
              <span>纽约美东 (EDT/EST)</span>
            </div>
            <div class="tz-time">{{ clockData.nyTime }}</div>
          </div>

          <div class="tz-item">
            <div class="tz-name">
              <span class="tz-flag">🇬🇧</span>
              <span>伦敦时间 (BST/GMT)</span>
            </div>
            <div class="tz-time">{{ clockData.londonTime }}</div>
          </div>
        </div>
      </div>

      <!-- 开发者与极客专用：Unix 毫秒时间戳 -->
      <div class="popover-section">
        <div class="section-label">Unix 时间戳 (Epoch)</div>
        <div class="timestamp-box" @click="copyTimestamp">
          <span class="ts-num">{{ clockData.timestamp }}</span>
          <div class="copy-action">
            <n-icon :component="copied ? CheckOne : Copy" size="14" />
            <span class="copy-text">{{ copied ? '已复制' : '复制' }}</span>
          </div>
        </div>
      </div>

      <!-- 传统历法与干支纪年 -->
      <div class="popover-footer" v-if="clockData.lunarText">
        <div class="lunar-detail">
          <span class="lunar-item">{{ clockData.lunarGanZhi }}年</span>
          <span class="lunar-item">{{ clockData.lunarMonth }}</span>
          <span class="lunar-item">{{ clockData.lunarDay }}</span>
          <span class="lunar-badge">农历</span>
        </div>
      </div>
    </div>
  </n-popover>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { useRoute } from "vue-router";
import { Time, Copy, CheckOne } from "@icon-park/vue-next";
import { getCurrentTime } from "@/utils/getTime.js";
import { mainStore } from "@/store";

const props = defineProps({
  // 是否强制为紧凑横向模式
  compact: {
    type: Boolean,
    default: false,
  },
});

const route = useRoute();
const store = mainStore();

// 复制状态提示
const copied = ref(false);

// 当前是否在 /stream 路由
const isStreamRoute = computed(() => {
  return route.path === "/stream";
});

// 本地即时计算的高精度时钟状态（秒级驱动，纳秒级无抖动）
const now = ref(new Date());
let timer = null;

const updateTime = () => {
  now.value = new Date();
};

onMounted(() => {
  updateTime();
  timer = setInterval(updateTime, 1000);
});

onBeforeUnmount(() => {
  if (timer) {
    clearInterval(timer);
  }
});

// 计算所有时钟与时区数据
const clockData = computed(() => {
  const d = now.value;
  const storeTime = store.timeData || getCurrentTime();

  // 基础公历
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const seconds = String(d.getSeconds()).padStart(2, "0");
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");

  const weekdaysShort = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const weekdayShort = weekdaysShort[d.getDay()];

  // 国际多时区时间格式化（HH:mm:ss）
  const formatTzTime = (timeZone) => {
    try {
      return new Intl.DateTimeFormat("zh-CN", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(d);
    } catch {
      return `${hours}:${minutes}:${seconds}`;
    }
  };

  const beijingTime = `${hours}:${minutes}:${seconds}`;
  const utcTime = formatTzTime("UTC");
  const nyTime = formatTzTime("America/New_York");
  const londonTime = formatTzTime("Europe/London");

  // 农历数据
  const lunarText = storeTime?.lunar?.text || "";
  const lunarGanZhi = storeTime?.lunar?.GanZhiYear || "";
  const lunarMonth = storeTime?.lunar?.month || "";
  const lunarDay = storeTime?.lunar?.day || "";

  return {
    hours,
    minutes,
    seconds,
    year,
    month,
    day,
    weekdayShort,
    timestamp: d.getTime(),
    beijingTime,
    utcTime,
    nyTime,
    londonTime,
    lunarText,
    lunarGanZhi,
    lunarMonth,
    lunarDay,
  };
});

// 复制时间戳
const copyTimestamp = async (e) => {
  e.stopPropagation();
  try {
    const tsStr = String(clockData.value.timestamp);
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(tsStr);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = tsStr;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    copied.value = true;
    window.$message?.success?.(`已复制当前毫秒时间戳: ${tsStr}`);
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch (err) {
    console.error("复制失败", err);
  }
};
</script>

<style lang="scss" scoped>
// -------------------------------------------------------------
// 时钟胶囊主容器 (Glassmorphism Capsule)
// -------------------------------------------------------------
.stream-clock-capsule {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 20px;
  background: var(--n-color);
  border: 1px solid var(--n-border-color);
  box-shadow: 0 4px 16px -2px rgba(0, 0, 0, 0.04);
  cursor: pointer;
  user-select: none;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  box-sizing: border-box;

  &:hover {
    transform: translateY(-1px);
    border-color: rgba(24, 160, 88, 0.4);
    box-shadow: 0 6px 20px -2px rgba(24, 160, 88, 0.12),
      0 2px 8px rgba(0, 0, 0, 0.05);

    .capsule-header .live-status .live-dot {
      background: #18a058;
      box-shadow: 0 0 10px #18a058;
    }

    .capsule-time .second-group .second-num {
      color: #18a058;
    }
  }

  // 默认：全景模式显示，紧凑模式隐藏
  .compact-view {
    display: none;
  }

  .full-view {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 8px 18px 7px 18px;
    min-width: 170px;
    box-sizing: border-box;
  }

  // 顶栏：实时指示灯与时区标记
  .capsule-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    margin-bottom: 2px;

    .live-status {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      position: relative;

      .live-pulse {
        position: absolute;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #18a058;
        opacity: 0.75;
        animation: radarPing 2s cubic-bezier(0, 0, 0.2, 1) infinite;
      }

      .live-dot {
        position: relative;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #18a058;
        box-shadow: 0 0 6px rgba(24, 160, 88, 0.8);
      }

      .live-text {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.5px;
        color: #18a058;
        line-height: 1;
        text-transform: uppercase;
      }
    }

    .timezone-badge {
      font-size: 10px;
      font-weight: 600;
      color: var(--n-text-color-3);
      background: var(--n-border-color);
      padding: 1px 5px;
      border-radius: 6px;
      line-height: 1.2;
    }
  }

  // 中行：数码时钟核心
  .capsule-time {
    display: flex;
    align-items: baseline;
    justify-content: center;
    font-family: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, "PingFang SC", monospace;
    font-variant-numeric: tabular-nums;
    font-feature-settings: "tnum";
    letter-spacing: -0.3px;
    line-height: 1.1;

    .hour-min {
      font-size: 22px;
      font-weight: 800;
      color: var(--n-text-color);

      .colon {
        display: inline-block;
        margin: 0 1px;
        color: var(--n-text-color-3);
        animation: colonBreath 1s ease-in-out infinite;
      }
    }

    .second-group {
      display: inline-flex;
      align-items: baseline;
      margin-left: 2px;

      .second-dot {
        font-size: 14px;
        font-weight: 600;
        color: var(--n-text-color-3);
        margin-right: 1px;
        opacity: 0.7;
      }

      .second-num {
        font-size: 14px;
        font-weight: 700;
        color: var(--n-text-color-2);
        transition: color 0.2s;
      }
    }
  }

  // 底栏：公历日期 · 星期 · 农历干支
  .capsule-footer {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    margin-top: 3px;
    font-size: 11px;
    color: var(--n-text-color-3);
    line-height: 1.2;
    white-space: nowrap;

    .footer-dot {
      opacity: 0.4;
    }

    .lunar-text {
      opacity: 0.85;
    }
  }

  // -------------------------------------------------------------
  // 紧凑横向模式 (当 compact 为 true，或在 .header.show 吸顶模式下生效)
  // -------------------------------------------------------------
  &.is-compact,
  :global(.header.show) & {
    min-width: auto;
    padding: 5px 14px;
    border-radius: 16px;

    .full-view {
      display: none;
    }

    .compact-view {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      font-family: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, "PingFang SC", monospace;
      font-variant-numeric: tabular-nums;
      font-feature-settings: "tnum";

      .live-dot-wrap {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 8px;
        height: 8px;

        .live-pulse {
          position: absolute;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #18a058;
          opacity: 0.75;
          animation: radarPing 2s cubic-bezier(0, 0, 0.2, 1) infinite;
        }

        .live-dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: #18a058;
          box-shadow: 0 0 4px #18a058;
        }
      }

      .compact-time {
        font-size: 14px;
        font-weight: 700;
        color: var(--n-text-color);
        letter-spacing: -0.2px;

        .colon {
          opacity: 0.6;
          animation: colonBreath 1s ease-in-out infinite;
        }
      }

      .compact-divider {
        color: var(--n-text-color-3);
        opacity: 0.5;
        font-size: 11px;
      }

      .compact-date {
        font-size: 12px;
        color: var(--n-text-color-3);
        font-weight: 500;
      }
    }
  }
}

// -------------------------------------------------------------
// 浮窗详情卡片 (Telemetry Card in Popover)
// -------------------------------------------------------------
.telemetry-popover-card {
  width: 290px;
  padding: 14px 16px;
  background: var(--n-color);
  border: 1px solid var(--n-border-color);
  border-radius: 14px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12);
  user-select: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;

  .popover-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--n-border-color);

    .header-title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-weight: 700;
      color: var(--n-text-color);

      .title-icon {
        color: #18a058;
      }
    }

    .status-tag {
      font-size: 11px;
      padding: 0 6px;

      .popover-live-dot {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: #18a058;
        display: inline-block;
        margin-right: 4px;
      }
    }
  }

  .popover-section {
    margin-top: 10px;

    .section-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--n-text-color-3);
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }

    // 全球主要时区网格
    .tz-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 6px;

      .tz-item {
        padding: 6px 8px;
        border-radius: 8px;
        background: var(--n-border-color);
        display: flex;
        flex-direction: column;
        gap: 2px;
        transition: all 0.2s;

        &.active {
          border: 1px solid rgba(24, 160, 88, 0.35);
          background: rgba(24, 160, 88, 0.08);

          .tz-time {
            color: #18a058;
            font-weight: 700;
          }
        }

        .tz-name {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 10px;
          color: var(--n-text-color-3);

          .tz-flag {
            font-size: 12px;
          }
        }

        .tz-time {
          font-family: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace;
          font-variant-numeric: tabular-nums;
          font-size: 13px;
          font-weight: 600;
          color: var(--n-text-color);
          line-height: 1.1;
        }
      }
    }

    // 时间戳复制栏
    .timestamp-box {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 10px;
      border-radius: 8px;
      background: var(--n-border-color);
      cursor: pointer;
      transition: background 0.2s;

      &:hover {
        background: rgba(24, 160, 88, 0.12);

        .copy-action {
          color: #18a058;
        }
      }

      .ts-num {
        font-family: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace;
        font-variant-numeric: tabular-nums;
        font-size: 13px;
        font-weight: 600;
        color: var(--n-text-color);
        letter-spacing: 0.5px;
      }

      .copy-action {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        color: var(--n-text-color-3);
        transition: color 0.2s;

        .copy-text {
          font-weight: 600;
        }
      }
    }
  }

  // 底部农历详情
  .popover-footer {
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px dashed var(--n-border-color);

    .lunar-detail {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--n-text-color-3);

      .lunar-badge {
        margin-left: auto;
        font-size: 10px;
        padding: 0 5px;
        border-radius: 4px;
        background: var(--n-border-color);
      }
    }
  }
}

// -------------------------------------------------------------
// 动画定义 (Animations)
// -------------------------------------------------------------
@keyframes radarPing {
  0% {
    transform: scale(0.95);
    opacity: 0.8;
  }
  70% {
    transform: scale(2.3);
    opacity: 0;
  }
  100% {
    transform: scale(2.4);
    opacity: 0;
  }
}

@keyframes colonBreath {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}
</style>
