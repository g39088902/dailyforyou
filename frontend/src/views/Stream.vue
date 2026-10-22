<template>
  <div class="stream-view">
    <!-- 顶部降级提示条（如果处于 degraded 状态） -->
    <n-alert
      v-if="store.sourcesStatus === 'degraded'"
      type="warning"
      closable
      :bordered="false"
      class="degraded-banner"
    >
      信源清单可能不是最新，正在后台重试连接后端...
    </n-alert>

    <!-- 顶部状态栏与操作面板 -->
    <stream-header
      :source-count="sourceCount"
      :total-news-count="totalNewsCount"
      :scored-news-count="scoredNewsCount"
      :cached-score-count="cachedScoreCount"
      :read-news-count="readNewsCount"
      :hidden-read-count="hiddenReadCount"
      :is-loading="isLoading"
      :loaded-sources-count="loadedSourcesCount"
      :is-scoring="isScoring"
      :active-score-workers="activeScoreWorkers"
      :max-score-concurrency="MAX_SCORE_CONCURRENCY"
      @reload="loadAllSourcesSequentially(true)"
    />

    <!-- 顶部信源快捷导航 -->
    <stream-source-nav
      :sources="visibleSources"
      :current-filter="currentSourceFilter"
      :loading-map="sourceLoadingMap"
      :data-map="sourceDataMap"
      @filter="filterBySource"
    />

    <!-- 聚合主列表（不分页，已打分按分数降序，未打分按原顺序） -->
    <n-card class="stream-card" :bordered="false">
      <!-- 初始未就绪或未初始化状态 -->
      <div
        v-if="store.sourcesStatus === 'uninitialized' && store.sources.length === 0"
        class="empty-state"
      >
        <n-empty description="正在初始化，请稍后重试">
          <template #extra>
            <n-button
              size="small"
              type="primary"
              :loading="store.sourcesLoading"
              @click="store.loadSources()"
            >
              重试连接
            </n-button>
          </template>
        </n-empty>
      </div>

      <!-- 初始无任何数据且正在加载第一个信源时的骨架 -->
      <div
        v-else-if="isLoading && allArticles.length === 0"
        class="loading-state"
      >
        <div class="first-load-tip">
          <n-spin size="medium" />
          <n-text :depth="2" style="margin-left: 12px">
            正在优先请求第 1 个信源（{{ currentFetchingSourceLabel }}），获取后立即呈现在列表...
          </n-text>
        </div>
        <n-skeleton text round :repeat="10" height="38px" style="margin-top: 20px" />
      </div>

      <div v-else-if="allArticles.length === 0 && !isLoading" class="empty-state">
        <n-empty description="暂无热点资讯或所有信源已在设置中关闭">
          <template #extra>
            <n-button
              size="small"
              secondary
              strong
              @click="router.push('/setting')"
            >
              前往设置开启榜单
            </n-button>
          </template>
        </n-empty>
      </div>

      <div
        v-else-if="displayedArticles.length === 0 && !isLoading"
        class="empty-state"
      >
        <n-empty :description="`全部 ${allArticles.length} 条内容均已阅读过并被隐藏`">
          <template #extra>
            <n-button
              size="small"
              secondary
              strong
              @click="store.hideReadNews = false"
            >
              显示已看过的内容
            </n-button>
          </template>
        </n-empty>
      </div>

      <div v-else class="stream-list">
        <n-list hoverable clickable>
          <stream-article-item
            v-for="(item, index) in displayedArticles"
            :key="item._uniqueKey || `${item._sourceKey}-${item.id || index}`"
            :ref="getArticleItemRefSetter(item._uniqueKey)"
            :item="item"
            :index="index"
            :font-size="store.listFontSize"
            @click="jumpLink"
            @filter-source="filterBySource"
            @toggle-read="toggleReadStatus"
            @commit-score="commitManualScore"
          />
        </n-list>
      </div>

      <!-- 底部加载进度条与完成状态 -->
      <stream-progress-footer
        :is-loading="isLoading"
        :is-scoring="isScoring"
        :current-fetching-source-label="currentFetchingSourceLabel"
        :loaded-sources-count="loadedSourcesCount"
        :source-count="sourceCount"
        :scored-news-count="scoredNewsCount"
        :total-news-count="totalNewsCount"
        :active-score-workers="activeScoreWorkers"
        :max-score-concurrency="MAX_SCORE_CONCURRENCY"
        :progress-percentage="progressPercentage"
        :score-progress-percentage="scoreProgressPercentage"
        :all-articles-count="allArticles.length"
        :cached-score-count="cachedScoreCount"
        :read-news-count="readNewsCount"
      />
    </n-card>
  </div>
</template>

<script setup>
import { computed, onActivated, onBeforeUnmount, onMounted, watch } from "vue";
import { useRouter } from "vue-router";
import { mainStore } from "@/store";
import { useAuthStore } from "@/store/auth";

import StreamHeader from "@/components/Stream/StreamHeader.vue";
import StreamSourceNav from "@/components/Stream/StreamSourceNav.vue";
import StreamArticleItem from "@/components/Stream/StreamArticleItem.vue";
import StreamProgressFooter from "@/components/Stream/StreamProgressFooter.vue";

import { useStreamReadStatus } from "@/components/Stream/composables/useStreamReadStatus";
import { useStreamScoring } from "@/components/Stream/composables/useStreamScoring";
import { useStreamSources } from "@/components/Stream/composables/useStreamSources";

const router = useRouter();
const store = mainStore();

// 1. 已读状态管理
const {
  displayedReadSet,
  persistedReadSet,
  sessionNewlyReadSet,
  articleMetaLookup,
  syncReadSetToStore,
  markArticleAsRead,
  toggleReadStatus,
  commitSessionReadToDisplayed,
  handleScoreReadSync,
  initReadObserver,
  cleanupReadObserver,
  setArticleItemRef,
  getArticleItemRefSetter,
  loadReadHashesFromBackend,
  resetReadState,
} = useStreamReadStatus({
  onReadStatusChange: (uniqueKey, isRead) => {
    if (scoreMap[uniqueKey]) {
      scoreMap[uniqueKey].isRead = isRead;
    }
  },
});

// 2. AI评分并发管理
const {
  MAX_SCORE_CONCURRENCY,
  scoreMap,
  activeScoreWorkers,
  pendingQueueCount,
  isScoring,
  resetScoreQueue,
  enqueueSourceArticlesForScoring,
  commitManualScore,
  cleanupScoring,
} = useStreamScoring({
  isAborted: () => isAborted(),
  onScoreReadSync: handleScoreReadSync,
});

// 3. 信源加载与顺序管理
const {
  currentSourceFilter,
  sourceDataMap,
  sourceLoadingMap,
  isLoading,
  currentFetchingSourceLabel,
  visibleSources,
  activeSources,
  sourceCount,
  loadedSourcesCount,
  progressPercentage,
  filterBySource,
  loadAllSourcesSequentially,
  abort,
  isAborted,
} = useStreamSources({
  onBeforeLoadAll: ({ isNew }) => {
    commitSessionReadToDisplayed();
    return resetScoreQueue(isNew);
  },
  onSourceReady: (source, items, isNew, runId) => {
    enqueueSourceArticlesForScoring(source, items, isNew, runId);
  },
});

// 4. 登录态与 Prompt 变化
const authStore = useAuthStore();
let lastScoredUserId = authStore.userId;
let lastAppliedPromptHash = authStore.promptHash;

watch(
  () => authStore.userId,
  async (userId) => {
    if (userId === lastScoredUserId) return;
    lastScoredUserId = userId;
    lastAppliedPromptHash = authStore.promptHash;

    resetScoreQueue(true);
    resetReadState();

    if (userId) {
      await loadReadHashesFromBackend();
      loadAllSourcesSequentially(false);
    }
  }
);

watch(
  () => authStore.promptHash,
  (hash) => {
    if (!authStore.isAuthed || !hash || hash === lastAppliedPromptHash) return;
    lastAppliedPromptHash = hash;
    resetScoreQueue(true);
    loadAllSourcesSequentially(false);
  }
);

// 5. 汇总并排序新闻列表
const allArticles = computed(() => {
  const merged = [];
  let originalIndex = 0;

  for (const source of activeSources.value) {
    if (currentSourceFilter.value && currentSourceFilter.value !== source.key) {
      continue;
    }
    const res = sourceDataMap[source.key];
    if (res && Array.isArray(res.data)) {
      res.data.forEach((item, index) => {
        const uniqueKey = `${source.key}-${item.id || item.url || index}`;
        const scoreInfo = scoreMap[uniqueKey];
        const hasScore =
          scoreInfo && scoreInfo.status === "done" && typeof scoreInfo.score === "number";
        const newsHash = scoreInfo?.newsHash || item.newsHash || "";

        const isRead =
          displayedReadSet.has(uniqueKey) ||
          (newsHash ? displayedReadSet.has(newsHash) : false);

        const scoreStatus = scoreInfo?.status || "idle";
        const score = hasScore ? scoreInfo.score : undefined;
        const reason = hasScore ? scoreInfo.reason : undefined;
        const resolvedHash = newsHash || undefined;
        const isUserModified = hasScore ? Boolean(scoreInfo.isUserModified) : false;
        const fromCache = hasScore ? Boolean(scoreInfo.fromCache) : false;
        const sourceOrder = source.order ?? 0;
        const currentOriginalIndex = originalIndex++;

        const prevObj = articleMetaLookup.get(uniqueKey);
        if (
          prevObj &&
          prevObj._rawItem === item &&
          prevObj._sourceKey === source.key &&
          prevObj._sourceName === source.name &&
          prevObj._sourceLabel === source.label &&
          prevObj._sourceLogo === source.logo &&
          prevObj._sourceOrder === sourceOrder &&
          prevObj._indexInSource === index &&
          prevObj._originalIndex === currentOriginalIndex &&
          prevObj._scoreStatus === scoreStatus &&
          prevObj._score === score &&
          prevObj._reason === reason &&
          prevObj._newsHash === resolvedHash &&
          prevObj._isUserModified === isUserModified &&
          prevObj._fromCache === fromCache &&
          prevObj._isRead === isRead
        ) {
          merged.push(prevObj);
          return;
        }

        const articleObj = {
          ...item,
          _rawItem: item,
          _sourceKey: source.key,
          _sourceName: source.name,
          _sourceLabel: source.label,
          _sourceLogo: source.logo,
          _sourceOrder: sourceOrder,
          _indexInSource: index,
          _originalIndex: currentOriginalIndex,
          _uniqueKey: uniqueKey,
          _scoreStatus: scoreStatus,
          _score: score,
          _reason: reason,
          _newsHash: resolvedHash,
          _isUserModified: isUserModified,
          _fromCache: fromCache,
          _isRead: isRead,
        };

        articleMetaLookup.set(uniqueKey, articleObj);
        merged.push(articleObj);
      });
    }
  }

  merged.sort((a, b) => {
    const aScored = typeof a._score === "number";
    const bScored = typeof b._score === "number";

    if (aScored && bScored) {
      if (b._score !== a._score) {
        return b._score - a._score;
      }
      return a._originalIndex - b._originalIndex;
    }

    if (aScored !== bScored) {
      return aScored ? -1 : 1;
    }

    return a._originalIndex - b._originalIndex;
  });

  return merged;
});

const displayedArticles = computed(() => {
  if (!store.hideReadNews) {
    return allArticles.value;
  }
  return allArticles.value.filter((item) => !item._isRead);
});

const streamStats = computed(() => {
  const list = allArticles.value;
  let scored = 0;
  let cached = 0;
  let read = 0;
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (typeof item._score === "number") {
      scored++;
      if (item._fromCache) cached++;
    }
    if (item._isRead) {
      read++;
    }
  }
  return {
    total: list.length,
    scored,
    cached,
    read,
  };
});

const totalNewsCount = computed(() => streamStats.value.total);
const scoredNewsCount = computed(() => streamStats.value.scored);
const cachedScoreCount = computed(() => streamStats.value.cached);
const readNewsCount = computed(() => streamStats.value.read);

const hiddenReadCount = computed(() => {
  return Math.max(0, allArticles.value.length - displayedArticles.value.length);
});

const scoreProgressPercentage = computed(() => {
  if (totalNewsCount.value === 0) return 0;
  return Math.min(
    100,
    Math.round((scoredNewsCount.value / totalNewsCount.value) * 100)
  );
});

const jumpLink = (data) => {
  if (data && !persistedReadSet.has(data._uniqueKey)) {
    markArticleAsRead(data, true, false);
  }
  if (!data.url && !data.mobileUrl) {
    window.$message?.error("链接不存在");
    return;
  }
  const url = (window.innerWidth > 680 ? data.url : data.mobileUrl) || data.url;
  if (store.linkOpenType === "open") {
    window.open(url, "_blank");
  } else if (store.linkOpenType === "href") {
    window.location.href = url;
  }
};

onMounted(() => {
  initReadObserver();
  loadReadHashesFromBackend();
  loadAllSourcesSequentially(false);
});

onActivated(() => {
  if (authStore.isAuthed && Object.keys(scoreMap).length === 0) {
    loadReadHashesFromBackend();
    loadAllSourcesSequentially(false);
  }
});

onBeforeUnmount(() => {
  abort();
  cleanupScoring();
  cleanupReadObserver();
});
</script>

<style lang="scss" scoped>
.stream-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-bottom: 60px;

  .degraded-banner {
    border-radius: 8px;
  }

  .stream-card {
    border-radius: 12px;

    .loading-state {
      padding: 24px;
      .first-load-tip {
        display: flex;
        align-items: center;
      }
    }

    .empty-state {
      padding: 60px 0;
    }

    .stream-list {
      // 保持列表容器排版
    }
  }
}
</style>
