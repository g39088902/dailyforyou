import { ref, reactive, computed, watch } from "vue";
import { mainStore } from "@/store";
import { getHotLists } from "@/api";

export function useStreamSources({ onBeforeLoadAll, onSourceReady } = {}) {
  const store = mainStore();

  const currentSourceFilter = ref(null);
  const sourceDataMap = reactive({});
  const sourceLoadingMap = reactive({});
  // 每个信源当前生效的时间窗口（小时）。只有「查看更早内容」会把某个源覆盖成 0（不限），
  // 其余情况留空表示跟随后端默认值。
  const maxAgeOverrides = reactive({});
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

  // 后端实际生效的窗口（小时），用于空态文案；0 表示已关闭过滤，不作为文案依据
  const windowHours = computed(() => {
    const hours = Object.values(sourceDataMap)
      .map((res) => res?.maxAgeHours)
      .filter((h) => typeof h === "number" && h > 0);
    return hours.length > 0 ? hours[0] : 48;
  });

  // 窗口内为空、但库里还有更早内容的信源 —— 「查看更早内容」的作用范围
  const emptyByAgeKeys = computed(() => {
    return activeSources.value
      .filter((source) => {
        const res = sourceDataMap[source.key];
        return (
          res?.code === 200 &&
          Array.isArray(res.data) &&
          res.data.length === 0 &&
          res.hasOlder === true
        );
      })
      .map((source) => source.key);
  });

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

    // 显式刷新全部时回到默认窗口，避免上一次「查看更早内容」的覆盖残留
    if (isNew) {
      Object.keys(maxAgeOverrides).forEach((key) => delete maxAgeOverrides[key]);
    }

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
      const cached = sourceDataMap[source.key];

      // 复用缓存前必须比较时间窗口口径，否则「查看更早内容」会直接命中缓存、请求根本不发，
      // 按钮看起来毫无反应。
      const desired = maxAgeOverrides[source.key];
      const cachedHours = cached?.maxAgeHours;
      const cacheMatches =
        desired === undefined ? cachedHours !== 0 : cachedHours === desired;

      // 非强制刷新且已有同口径缓存时，直接复用并按当前排序入队未打分条目
      if (!isNew && cached?.code === 200 && cacheMatches) {
        sourceLoadingMap[source.key] = false;
        onSourceReady?.(source, cached.data, false, runId);
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

  /**
   * 用指定时间窗口重拉一组信源，用于「查看更早内容」。
   *
   * 刻意绕开 loadAllSourcesSequentially：
   * - 它开头会调 onBeforeLoadAll → resetScoreQueue(isNew)，isNew=true 时清空整个评分地图；
   * - 它每源调 onSourceReady → 几百条历史条目一次性涌进打分队列，触发大批 AI 调用；
   *   且若传入新造的 runId，pumpScoreQueue 的 `runId === currentScoreRunId` 守卫
   *   会让队列永不消费，顶栏「AI 评分中」永远转圈。
   *
   * 历史条目保持无分状态即可：排序时未打分条目自然沉在已打分条目之后，符合预期。
   */
  const refetchSources = async (keys, { maxAgeHours = 0 } = {}) => {
    const targets = (keys || []).filter(Boolean);
    let changed = 0;

    for (const key of targets) {
      const source = store.sources.find((s) => s.key === key);
      if (!source) continue;

      sourceLoadingMap[key] = true;
      try {
        const res = await getHotLists(source, true, { maxAge: maxAgeHours });
        if (res && res.code === 200) {
          maxAgeOverrides[key] = maxAgeHours;
          sourceDataMap[key] = res;
          changed += 1;
        } else if (res && res.code === 404) {
          delete sourceDataMap[key];
          store.removeOfflineSource(key);
        }
      } catch (err) {
        console.error(`信源 ${source.label} 历史内容加载失败:`, err);
      } finally {
        sourceLoadingMap[key] = false;
      }
    }

    return changed;
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
    maxAgeOverrides,
    windowHours,
    emptyByAgeKeys,
    isLoading,
    currentFetchingSourceLabel,
    visibleSources,
    activeSources,
    sourceCount,
    loadedSourcesCount,
    progressPercentage,
    filterBySource,
    loadAllSourcesSequentially,
    refetchSources,
    abort,
    isAborted,
  };
}
