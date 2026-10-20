<template>
  <div class="page-header">
    <div class="left">
      <div class="logo-area" @click="router.push('/')">
        <img src="/ico/favicon.png" alt="logo" class="site-logo" />
        <div class="logo-text">
          <n-text class="main-title">今日热榜</n-text>
          <n-text :depth="3" class="sub-title">全网实时情报中枢</n-text>
        </div>
      </div>
      <StreamClock />
    </div>
    <div class="right">
      <n-space align="center">
        <div class="hide-read-toggle" @click="store.hideReadNews = !store.hideReadNews">
          <n-switch
            v-model:value="store.hideReadNews"
            size="small"
            @click.stop
          />
          <span class="toggle-label">
            隐藏已看过的内容
            <template v-if="readNewsCount > 0">({{ readNewsCount }})</template>
          </span>
        </div>
        <n-tag v-if="isLoading" round type="info" size="small">
          信源加载 ({{ loadedSourcesCount }}/{{ sourceCount }})
        </n-tag>
        <n-tag v-else round type="success" size="small">信源加载完成</n-tag>
        <n-tag v-if="isScoring" round type="warning" size="small">
          AI 评分中 ({{ scoredNewsCount }}/{{ totalNewsCount }} · 并发 {{ activeScoreWorkers }}/{{ maxScoreConcurrency }})
        </n-tag>
        <n-tag v-else-if="totalNewsCount > 0 && scoredNewsCount > 0" round type="success" size="small">
          AI 评分完成 ({{ scoredNewsCount }}/{{ totalNewsCount }})
        </n-tag>
        <n-button
          secondary
          strong
          round
          :loading="isLoading"
          @click="$emit('reload')"
        >
          <template #icon>
            <n-icon :component="Refresh" />
          </template>
          重新加载全部
        </n-button>
        <n-popover>
          <template #trigger>
            <n-button
              secondary
              strong
              round
              @click="
                store.setSiteTheme(
                  store.siteTheme === 'light' ? 'dark' : 'light'
                )
              "
            >
              <template #icon>
                <n-icon
                  :component="store.siteTheme === 'light' ? Moon : SunOne"
                />
              </template>
            </n-button>
          </template>
          {{ store.siteTheme === "light" ? "深色模式" : "浅色模式" }}
        </n-popover>
        <n-popover>
          <template #trigger>
            <n-button secondary strong round @click="router.push('/setting')">
              <template #icon>
                <n-icon :component="SettingTwo" />
              </template>
            </n-button>
          </template>
          全局设置
        </n-popover>
      </n-space>
    </div>
  </div>
</template>

<script setup>
import { useRouter } from "vue-router";
import { Refresh, SunOne, Moon, SettingTwo } from "@icon-park/vue-next";
import StreamClock from "@/components/Stream/StreamClock.vue";
import { mainStore } from "@/store";

const router = useRouter();
const store = mainStore();

defineProps({
  sourceCount: {
    type: Number,
    default: 0,
  },
  totalNewsCount: {
    type: Number,
    default: 0,
  },
  scoredNewsCount: {
    type: Number,
    default: 0,
  },
  cachedScoreCount: {
    type: Number,
    default: 0,
  },
  readNewsCount: {
    type: Number,
    default: 0,
  },
  hiddenReadCount: {
    type: Number,
    default: 0,
  },
  isLoading: {
    type: Boolean,
    default: false,
  },
  loadedSourcesCount: {
    type: Number,
    default: 0,
  },
  isScoring: {
    type: Boolean,
    default: false,
  },
  activeScoreWorkers: {
    type: Number,
    default: 0,
  },
  maxScoreConcurrency: {
    type: Number,
    default: 5,
  },
});

defineEmits(["reload"]);
</script>

<style lang="scss" scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;

  .left {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;

    .logo-area {
      display: flex;
      align-items: center;
      gap: 10px;
      cursor: pointer;
      user-select: none;
      transition: opacity 0.2s;

      &:hover {
        opacity: 0.85;
      }

      .site-logo {
        width: 36px;
        height: 36px;
        border-radius: 8px;
        object-fit: cover;
      }

      .logo-text {
        display: flex;
        flex-direction: column;

        .main-title {
          font-size: 18px;
          font-weight: bold;
          line-height: 1.2;
        }

        .sub-title {
          font-size: 11px;
          line-height: 1.2;
          margin-top: 2px;
        }
      }
    }
  }

  .right {
    .hide-read-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 16px;
      background-color: var(--n-border-color);
      cursor: pointer;
      user-select: none;
      transition: opacity 0.2s;

      &:hover {
        opacity: 0.85;
      }

      .toggle-label {
        font-size: 12px;
        line-height: 1;
      }
    }
  }
}

@media (max-width: 680px) {
  .page-header {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
