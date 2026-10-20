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

  const activeSources = computed(() => {
    return store.newsArr.filter((item) => Boolean(item.show));
  });

  const sourceCount = computed(() => activeSources.value.length);

  const loadedSourcesCount = computed(() => {
    return activeSources.value.filter(
      (s) => !sourceLoadingMap[s.name] && sourceDataMap[s.name]
    ).length;
  });

  const progressPercentage = computed(() => {
    if (sourceCount.value === 0) return 0;
    return Math.min(
      100,
      Math.round((loadedSourcesCount.value / sourceCount.value) * 100)
    );
  });

  const filterBySource = (sourceName) => {
    if (currentSourceFilter.value === sourceName) {
      currentSourceFilter.value = null;
    } else {
      currentSourceFilter.value = sourceName;
    }
  };

  const abort = () => {
    abortController.aborted = true;
  };

  const loadAllSourcesSequentially = async (isNew = false) => {
    abort();
    const currentAbort = { aborted: false };
    abortController = currentAbort;

    const runId = onBeforeLoadAll ? onBeforeLoadAll({ isNew }) : 0;

    const sources = activeSources.value;
    if (!sources || sources.length === 0) {
      isLoading.value = false;
      currentFetchingSourceLabel.value = "";
      return;
    }

    const hasUnloadedSource =
      isNew || sources.some((s) => !sourceDataMap[s.name]);
    if (hasUnloadedSource) {
      isLoading.value = true;
    }

    for (let i = 0; i < sources.length; i++) {
      if (currentAbort.aborted) break;

      const source = sources[i];

      // 非强制刷新且已有缓存数据时，直接复用缓存并按当前排序入队未打分条目
      if (!isNew && sourceDataMap[source.name]?.code === 200) {
        sourceLoadingMap[source.name] = false;
        onSourceReady?.(source, sourceDataMap[source.name].data, false, runId);
        continue;
      }

      sourceLoadingMap[source.name] = true;
      currentFetchingSourceLabel.value = source.label;

      try {
        const res = await getHotLists(source.name, isNew, source.params);
        if (currentAbort.aborted) break;

        if (res && res.code === 200) {
          sourceDataMap[source.name] = res;
          onSourceReady?.(source, res.data, isNew, runId);
        }
      } catch (err) {
        console.error(`信源 ${source.label} 加载失败:`, err);
      } finally {
        sourceLoadingMap[source.name] = false;
      }
    }

    if (!currentAbort.aborted) {
      isLoading.value = false;
      currentFetchingSourceLabel.value = "";
    }
  };

  // 监听设置中信源排序或开启状态的变化，实时同步流式浏览
  watch(
    () => activeSources.value.map((s) => s.name).join(","),
    () => {
      if (
        currentSourceFilter.value &&
        !activeSources.value.some((s) => s.name === currentSourceFilter.value)
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
