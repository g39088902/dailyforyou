<template>
  <n-card
    v-if="sources.length > 0"
    class="anchor-bar"
    size="small"
    :bordered="false"
  >
    <div class="source-nav">
      <div
        v-for="source in sources"
        :key="source.key"
        class="source-nav-tag"
        :class="{
          active: currentFilter === source.key,
          loading: loadingMap[source.key],
          disabled: source.enabled === false,
        }"
        :title="titleOf(source)"
        @click="source.enabled !== false && $emit('filter', source.key)"
      >
        <img
          :src="resolveLogoUrl(source.logo)"
          :alt="source.label"
          class="source-nav-logo"
        />
        <span class="source-nav-label">{{ source.label }}</span>
        <i
          v-if="dotClassOf(source)"
          class="health-dot"
          :class="dotClassOf(source)"
        />
        <span class="source-nav-count">
          {{
            source.enabled === false
              ? "暂停"
              : loadingMap[source.key]
              ? "..."
              : dataMap[source.key]?.data?.length || 0
          }}
        </span>
      </div>
    </div>
  </n-card>
</template>

<script setup>
import { computed } from "vue";
import { resolveLogoUrl } from "@/api";
import { deriveSourceHealth } from "@/utils/sourceHealth";

const props = defineProps({
  sources: {
    type: Array,
    default: () => [],
  },
  currentFilter: {
    type: [String, null],
    default: null,
  },
  loadingMap: {
    type: Object,
    default: () => ({}),
  },
  dataMap: {
    type: Object,
    default: () => ({}),
  },
});

defineEmits(["filter"]);

// 只在清单变化时重算：24h/72h 阈值下，圆点晚半小时出现没有影响，
// 不为它引入全信源定时器。
const healthMap = computed(() => {
  const map = {};
  const now = Date.now();
  for (const source of props.sources) {
    map[source.key] = deriveSourceHealth(source.stats, now);
  }
  return map;
});

const dotClassOf = (source) => {
  // 停更标记与「暂不可用」互斥：后者已经有灰显 + 暂停文案，不该再叠一个红点
  if (source.enabled === false) return "";
  const level = healthMap.value[source.key]?.level;
  if (level === "dead") return "is-dead";
  if (level === "stale") return "is-stale";
  return "";
};

const titleOf = (source) => {
  if (source.enabled === false) return "该信源暂不可用";
  const health = healthMap.value[source.key];
  if (health?.label) return `${source.label} · ${health.label}`;
  if (health?.level === "unknown") return `${source.label} · 暂无内容`;
  return source.label;
};
</script>

<style lang="scss" scoped>
.anchor-bar {
  border-radius: 12px;
  background-color: var(--n-color);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);

  .source-nav {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;

    .source-nav-tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 16px;
      background-color: var(--n-border-color);
      font-size: 13px;
      cursor: pointer;
      transition: all 0.2s ease;
      user-select: none;

      .source-nav-logo {
        width: 16px;
        height: 16px;
        border-radius: 50%;
      }

      .source-nav-count {
        font-size: 11px;
        opacity: 0.7;
        background: rgba(0, 0, 0, 0.08);
        padding: 1px 6px;
        border-radius: 10px;
      }

      .health-dot {
        flex: 0 0 auto;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        margin-left: -2px;

        &.is-stale {
          background-color: #f0a020;
        }

        &.is-dead {
          background-color: #d03050;
        }
      }

      &:hover {
        opacity: 0.85;
        transform: translateY(-1px);
      }

      &.active {
        background-color: var(--n-color-primary, #18a058);
        color: #fff;

        .source-nav-count {
          background: rgba(255, 255, 255, 0.25);
          color: #fff;
        }
      }

      &.disabled {
        opacity: 0.45;
        cursor: not-allowed;
        filter: grayscale(1);

        &:hover {
          opacity: 0.45;
          transform: none;
        }
      }

      &.loading {
        animation: pulse 1.5s infinite;
      }
    }
  }
}

@keyframes pulse {
  0% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
  100% {
    opacity: 1;
  }
}
</style>
