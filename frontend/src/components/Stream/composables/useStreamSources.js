import { ref, reactive, computed, watch } from "vue";
import { mainStore } from "@/store";
import { getHotLists } from "@/api";

export function useStreamSources({ onBeforeLoadAll, onSourceReady } = {}) {
  const store = mainStore();

  const currentSourceFilter = ref(null);
  const sourceDataMap = reactive({});
  const sourceLoadingMap = reactive({});
  const isLoading = ref(false);
  const currentFetchingSourceLabel = ref("");
  let abortController = { aborted: false };

  const isAborted = () => abortController.aborted;

  // 用户在设置中开启的全部信源（含 enabled: false，供顶部导航展示灰显）
  const visibleSources = computed(() => {
    return store.sources.filter((item) => Boolean(item.show));
  });

  // 实际可拉取数据的活跃信源（排除 enabled === false 的暂不可用信源）
  const activeSources = computed(() => {
    return store.sources.filter(
      (item) => Boolean(item.show) && item.enabled !== false
    );
  });

  const sourceCount = computed(() => activeSources.value.length);

  const loadedSourcesCount = computed(() => {
    return activeSources.value.filter(
      (s) => !sourceLoadingMap[s.key] && sourceDataMap[s.key]
    ).length;
  });

  const progressPercentage = computed(() => {
    if (sourceCount.value === 0) return 0;
    return Math.min(
      100,
      Math.round((loadedSourcesCount.value / sourceCount.value) * 100)
    );
  });

  const filterBySource = (sourceKey) => {
    if (!sourceKey) return;
    const target = store.sources.find((s) => s.key === sourceKey);
    if (target && target.enabled === false) {
      return;
    }
    if (currentSourceFilter.value === sourceKey) {
      currentSourceFilter.value = null;
    } else {
      currentSourceFilter.value = sourceKey;
    }
  };

  const abort = () => {
    abortController.aborted = true;
  };

  const loadAllSourcesSequentially = async (isNew = false) => {
    abort();
    const currentAbort = { aborted: false };
    abortController = currentAbort;

    // 若清单尚未就绪或强制刷新，先拉取一次最新 /sources
    if (isNew || (store.sources.length === 0 && store.sourcesStatus === "idle")) {
      await store.loadSources();
      if (currentAbort.aborted) return;
    }

    const runId = onBeforeLoadAll ? onBeforeLoadAll({ isNew }) : 0;

    const sources = activeSources.value;
    if (!sources || sources.length === 0) {
      isLoading.value = false;
      currentFetchingSourceLabel.value = "";
      return;
    }

    const hasUnloadedSource =
      isNew || sources.some((s) => !sourceDataMap[s.key]);
    if (hasUnloadedSource) {
      isLoading.value = true;
    }

    for (let i = 0; i < sources.length; i++) {
      if (currentAbort.aborted) break;

      const source = sources[i];

      // 非强制刷新且已有缓存数据时，直接复用缓存并按当前排序入队未打分条目
      if (!isNew && sourceDataMap[source.key]?.code === 200) {
        sourceLoadingMap[source.key] = false;
        onSourceReady?.(source, sourceDataMap[source.key].data, false, runId);
        continue;
      }

      sourceLoadingMap[source.key] = true;
      currentFetchingSourceLabel.value = source.label;

      try {
        const res = await getHotLists(source, isNew);
        if (currentAbort.aborted) break;

        if (res && res.code === 200) {
          sourceDataMap[source.key] = res;
          onSourceReady?.(source, res.data, isNew, runId);
        } else if (res && res.code === 404) {
          delete sourceDataMap[source.key];
          store.removeOfflineSource(source.key);
        }
      } catch (err) {
        if (currentAbort.aborted) break;
        const status = err?.response?.status || err?.response?.data?.code;
        if (status === 404) {
          delete sourceDataMap[source.key];
          store.removeOfflineSource(source.key);
        } else {
          console.error(`信源 ${source.label} 加载失败:`, err);
        }
      } finally {
        sourceLoadingMap[source.key] = false;
      }
    }

    if (!currentAbort.aborted) {
      isLoading.value = false;
      currentFetchingSourceLabel.value = "";
    }
  };

  // 监听设置中信源排序、开启状态或后端清单更新的变化，实时同步流式浏览
  watch(
    () => activeSources.value.map((s) => s.key).join(","),
    () => {
      if (
        currentSourceFilter.value &&
        !activeSources.value.some((s) => s.key === currentSourceFilter.value)
      ) {
        currentSourceFilter.value = null;
      }
      loadAllSourcesSequentially(false);
    }
  );

  return {
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
  };
}
