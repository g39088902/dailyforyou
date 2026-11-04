<template>
  <n-list-item
    :data-unique-key="item._uniqueKey"
    @click="$emit('click', item)"
    class="stream-item"
    :class="{ 'is-read': item._isRead }"
  >
    <!-- 连续序号 -->
    <template #prefix>
      <n-text
        class="num"
        :class="{
          top1: index === 0,
          top2: index === 1,
          top3: index === 2,
        }"
        :depth="2"
      >
        {{ index + 1 }}
      </n-text>
    </template>

    <!-- 标题、热度、评分标签和信源标签 -->
    <div class="content">
      <div class="header-line">
        <n-tag
          size="small"
          round
          :bordered="false"
          class="source-tag"
          @click.stop="$emit('filter-source', item._sourceKey)"
        >
          <template #avatar>
            <img
              :src="resolveLogoUrl(item._sourceLogo)"
              :alt="item._sourceLabel"
              class="tag-logo"
            />
          </template>
          {{ item._sourceLabel }}
        </n-tag>

        <!-- 热度标签（紧跟渠道后面） -->
        <div class="hot-badge" v-if="item.hot">
          <n-icon :component="Fire" />
          <n-text class="hot-text" :depth="3" v-html="item.hot" />
        </div>

        <!-- 内容时间：既显示新闻发布时间，也显示系统爬取时间 -->
        <div
          v-if="timeMeta.pubAgeText || timeMeta.crawlAgeText"
          class="time-meta-group"
        >
          <span
            v-if="timeMeta.pubAgeText"
            class="time-badge pub-time"
            :title="`新闻发布时间：${timeMeta.pubExactTime}`"
          >
            <span class="time-label">发布</span>
            <span class="time-val">{{ timeMeta.pubAgeText }}</span>
          </span>
          <span
            v-if="timeMeta.crawlAgeText"
            class="time-badge crawl-time"
            :title="`系统爬取时间：${timeMeta.crawlExactTime}`"
          >
            <span class="time-label">爬取</span>
            <span class="time-val">{{ timeMeta.crawlAgeText }}</span>
          </span>
        </div>

        <!-- AI 评分徽章 -->
        <stream-score-badge
          :item="item"
          @commit="$emit('commit-score', $event)"
        />

        <!-- 已阅读标签 -->
        <n-tag
          v-if="item._isRead"
          size="small"
          round
          :bordered="false"
          class="read-status-tag"
          title="您已浏览过此条内容（点击可标记为未读）"
          @click.stop="$emit('toggle-read', item, false)"
        >
          已读
        </n-tag>

        <n-text
          class="item-title"
          :class="{ 'read-title': item._isRead }"
          :style="{ fontSize: fontSize + 'px' }"
        >
          {{ item.title }}
        </n-text>

        <!-- 命中/排除依据简述 -->
        <n-text v-if="item._reason" :depth="3" class="score-reason">
          {{ item._reason }}
        </n-text>
      </div>

      <!-- 描述内容（若有） -->
      <n-text
        v-if="item.desc"
        class="item-desc"
        :class="{ 'read-desc': item._isRead }"
        :depth="3"
        v-html="item.desc"
      />
    </div>
  </n-list-item>
</template>

<script setup>
import { computed } from "vue";
import { Fire } from "@icon-park/vue-next";
import { resolveLogoUrl } from "@/api";
import { getItemTimeMeta } from "@/utils/getTime";
import StreamScoreBadge from "./StreamScoreBadge.vue";

const props = defineProps({
  item: {
    type: Object,
    required: true,
  },
  index: {
    type: Number,
    required: true,
  },
  fontSize: {
    type: [Number, String],
    default: 14,
  },
  // 由 Stream.vue 每 60 秒推一次，避免每个条目各自起定时器
  nowMs: {
    type: Number,
    default: 0,
  },
});

defineEmits(["click", "filter-source", "toggle-read", "commit-score"]);

// 提取并兼顾展示新闻发布时间与爬取时间
const timeMeta = computed(() => {
  const now = props.nowMs || Date.now();
  return getItemTimeMeta(props.item, now);
});
</script>

<style lang="scss" scoped>
.stream-item {
  padding: 12px 8px;
  border-radius: 8px;
  transition: background-color 0.2s, opacity 0.2s;

  &.is-read {
    .num {
      opacity: 0.55;
    }
  }

  .num {
    font-size: 14px;
    font-weight: bold;
    min-width: 38px;
    display: inline-block;
    text-align: center;

    &.top1 {
      color: #ea4444;
    }
    &.top2 {
      color: #ea7044;
    }
    &.top3 {
      color: #ea9b44;
    }
  }

  .content {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;

    .header-line {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;

      .source-tag {
        cursor: pointer;
        background-color: var(--n-border-color);
        font-size: 12px;
        height: 22px;
        line-height: 22px;

        .tag-logo {
          width: 14px;
          height: 14px;
          border-radius: 50%;
        }

        &:hover {
          filter: brightness(0.95);
        }
      }

      .hot-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 12px;
        height: 22px;
        line-height: 22px;
        background: rgba(234, 68, 68, 0.08);
        color: #ea4444;
        padding: 0 8px;
        border-radius: 11px;
        white-space: nowrap;
        .hot-text {
          color: inherit;
        }
      }

      .time-meta-group {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        white-space: nowrap;

        .time-badge {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          height: 20px;
          line-height: 20px;
          padding: 0 6px;
          border-radius: 6px;
          font-size: 11px;
          cursor: default;
          white-space: nowrap;
          user-select: none;
          transition: all 0.2s;

          .time-label {
            font-weight: 500;
            opacity: 0.8;
          }

          .time-val {
            font-weight: normal;
          }

          &.pub-time {
            background: rgba(24, 160, 88, 0.08);
            color: var(--n-color-primary, #18a058);

            .time-label {
              color: var(--n-color-primary, #18a058);
            }
          }

          &.crawl-time {
            background: rgba(128, 128, 128, 0.1);
            color: var(--n-text-color-3, #8c8c8c);

            .time-label {
              color: var(--n-text-color-3, #8c8c8c);
            }
          }

          &:hover {
            filter: brightness(0.95);
          }
        }
      }

      .read-status-tag {
        font-size: 11px;
        height: 20px;
        line-height: 20px;
        padding: 0 7px;
        background: rgba(128, 128, 128, 0.12);
        color: var(--n-text-color-3, #888);
        cursor: pointer;
        user-select: none;
        transition: all 0.2s;

        &:hover {
          background: rgba(128, 128, 128, 0.22);
          color: var(--n-text-color-2, #555);
        }
      }

      .item-title {
        font-weight: 500;
        line-height: 1.4;
        word-break: break-all;
        transition: color 0.2s, opacity 0.2s;

        &.read-title {
          color: var(--n-text-color-3, #8c8c8c);
          font-weight: 400;
        }

        &:hover {
          color: var(--n-color-primary, #18a058);
        }
      }

      .score-reason {
        font-size: 12px;
        opacity: 0.75;
      }
    }

    .item-desc {
      font-size: 13px;
      line-height: 1.5;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      word-break: break-all;

      &.read-desc {
        opacity: 0.65;
      }
    }
  }
}
</style>
