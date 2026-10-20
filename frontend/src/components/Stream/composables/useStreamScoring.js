import { ref, reactive, computed } from "vue";
import { scoreNews, queryCachedScoresBatch, updateManualScore } from "@/api";

export const MAX_SCORE_CONCURRENCY = 5;

export function useStreamScoring({ onScoreReadSync, isAborted = () => false } = {}) {
  // key: _uniqueKey -> { status: 'pending' | 'scoring' | 'done' | 'error', score?: number, layer?: string, reason?: string, newsHash?: string, isUserModified?: boolean, fromCache?: boolean, isRead?: boolean }
  const scoreMap = reactive({});
  const scoreQueue = [];
  const activeScoreWorkers = ref(0);
  const activeCacheLookups = ref(0);
  const pendingQueueCount = ref(0);
  let currentScoreRunId = 0;

  // 标记后端是否支持 /score/cache 批量缓存查询接口（若后端未重启返回 404 则自动降级）
  let batchCacheSupported = true;

  // 批量缓冲高频返回的评分结果，按帧合并写入响应式 scoreMap，避免逐条阻塞主线程重排重绘
  const pendingScoreUpdates = new Map();
  const pendingReadSyncList = [];
  let flushTimer = null;

  const isScoring = computed(() => {
    return (
      activeScoreWorkers.value > 0 ||
      activeCacheLookups.value > 0 ||
      pendingQueueCount.value > 0 ||
      pendingScoreUpdates.size > 0
    );
  });

  const flushPendingScores = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    if (pendingReadSyncList.length > 0) {
      const readList = pendingReadSyncList.splice(0, pendingReadSyncList.length);
      for (let i = 0; i < readList.length; i++) {
        onScoreReadSync?.(readList[i]);
      }
    }

    if (pendingScoreUpdates.size > 0) {
      pendingScoreUpdates.forEach((val, key) => {
        const prev = scoreMap[key];
        scoreMap[key] = {
          ...(prev || {}),
          ...val,
          isRead: Boolean(val.isRead || prev?.isRead),
        };
      });
      pendingScoreUpdates.clear();
    }

    pendingQueueCount.value = scoreQueue.length;
  };

  const scheduleScoreFlush = (immediate = false) => {
    if (immediate) {
      flushPendingScores();
      return;
    }
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushPendingScores();
    }, 32);
  };

  const resetScoreQueue = (isNew = false) => {
    currentScoreRunId++;
    scoreQueue.length = 0;
    pendingQueueCount.value = 0;
    pendingScoreUpdates.clear();
    pendingReadSyncList.length = 0;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    if (isNew) {
      Object.keys(scoreMap).forEach((key) => {
        delete scoreMap[key];
      });
    } else {
      Object.keys(scoreMap).forEach((key) => {
        if (scoreMap[key]?.status === "pending") {
          delete scoreMap[key];
        }
      });
    }

    return currentScoreRunId;
  };

  const extractAndBufferScoreResult = (uniqueKey, res) => {
    const scoreVal = res?.score ?? res?.data?.score;
    const layerVal = res?.layer ?? res?.data?.layer;
    const reasonVal = res?.reason ?? res?.data?.reason;
    const newsHashVal = res?.newsHash ?? res?.data?.newsHash;
    const isUserModifiedVal = Boolean(
      res?.isUserModified ?? res?.data?.isUserModified
    );
    const fromCacheVal = Boolean(
      res?.fromCache ?? res?.data?.fromCache
    );
    const isReadFromDb = Boolean(
      res?.isRead ?? res?.data?.isRead
    );

    if (isReadFromDb || newsHashVal) {
      pendingReadSyncList.push({
        uniqueKey,
        newsHash: newsHashVal,
        isReadFromDb,
      });
    }

    if (typeof scoreVal === "number" && !Number.isNaN(scoreVal)) {
      pendingScoreUpdates.set(uniqueKey, {
        status: "done",
        score: scoreVal,
        layer: layerVal || "",
        reason: reasonVal || "",
        newsHash: newsHashVal || "",
        isUserModified: isUserModifiedVal,
        fromCache: fromCacheVal,
        isRead: isReadFromDb,
      });
    } else {
      pendingScoreUpdates.set(uniqueKey, {
        status: "error",
      });
    }
  };

  const pumpScoreQueue = (runId) => {
    while (
      activeScoreWorkers.value < MAX_SCORE_CONCURRENCY &&
      scoreQueue.length > 0 &&
      runId === currentScoreRunId &&
      !isAborted()
    ) {
      activeScoreWorkers.value++;

      (async () => {
        try {
          while (
            scoreQueue.length > 0 &&
            runId === currentScoreRunId &&
            !isAborted()
          ) {
            const task = scoreQueue.shift();
            if (!task) break;

            // 仅当请求耗时超过 120ms（说明未命中 3ms 本地缓存、正在请求远程 AI）时，才渲染“评分中...”状态
            // 避免 3ms 缓存命中条目触发多余的 pending -> scoring -> done 二次重绘
            let scoringStatusTimer = setTimeout(() => {
              scoringStatusTimer = null;
              if (runId !== currentScoreRunId || isAborted()) return;
              const current = scoreMap[task.uniqueKey];
              if (!current || current.status !== "done") {
                scoreMap[task.uniqueKey] = {
                  ...(current || {}),
                  status: "scoring",
                };
              }
            }, 120);

            try {
              const res = await scoreNews(
                {
                  title: task.title,
                  desc: task.desc,
                  source: task.source,
                },
                task.isNew
              );

              if (scoringStatusTimer) {
                clearTimeout(scoringStatusTimer);
                scoringStatusTimer = null;
              }

              if (runId !== currentScoreRunId || isAborted()) break;

              extractAndBufferScoreResult(task.uniqueKey, res);
              scheduleScoreFlush(scoreQueue.length === 0);
            } catch (err) {
              if (scoringStatusTimer) {
                clearTimeout(scoringStatusTimer);
                scoringStatusTimer = null;
              }
              if (runId !== currentScoreRunId || isAborted()) break;
              console.error(`新闻评分失败 [${task.title}]:`, err);
              pendingScoreUpdates.set(task.uniqueKey, {
                status: "error",
              });
              scheduleScoreFlush(scoreQueue.length === 0);
            }
          }
        } finally {
          activeScoreWorkers.value = Math.max(0, activeScoreWorkers.value - 1);
          if (activeScoreWorkers.value === 0 && scoreQueue.length === 0) {
            flushPendingScores();
          }
        }
      })();
    }
  };

  const enqueueSourceArticlesForScoring = (source, items, isNew, runId) => {
    if (!Array.isArray(items) || items.length === 0) return;

    const tasksToProcess = [];

    items.forEach((item, index) => {
      const uniqueKey = `${source.name}-${item.id || item.url || index}`;
      const existing = scoreMap[uniqueKey] || pendingScoreUpdates.get(uniqueKey);

      // 非强制刷新时，已完成打分的条目直接复用
      if (!isNew && existing && existing.status === "done" && typeof existing.score === "number") {
        return;
      }

      // 避免同一轮重复入队
      if (existing && (existing.status === "pending" || existing.status === "scoring")) {
        return;
      }

      scoreMap[uniqueKey] = {
        ...(existing || {}),
        status: "pending",
      };

      tasksToProcess.push({
        uniqueKey,
        title: item.title || "",
        desc: item.desc || "",
        source: source.label || source.name,
        isNew,
      });
    });

    if (tasksToProcess.length === 0) return;

    // 优先一次性批量查询该信源所有条目的 SQLite 本地缓存（毫秒级完成整批缓存加载，避免被慢速 AI 请求阻塞）
    if (batchCacheSupported) {
      activeCacheLookups.value++;
      (async () => {
        try {
          const res = await queryCachedScoresBatch(
            tasksToProcess.map((t) => ({
              title: t.title,
              desc: t.desc,
              source: t.source,
            }))
          );

          if (runId !== currentScoreRunId || isAborted()) return;

          const cachedList = Array.isArray(res?.data) ? res.data : null;
          if (!cachedList || cachedList.length !== tasksToProcess.length) {
            scoreQueue.push(...tasksToProcess);
            pendingQueueCount.value = scoreQueue.length;
            pumpScoreQueue(runId);
            return;
          }

          const cacheMissTasks = [];
          for (let i = 0; i < tasksToProcess.length; i++) {
            const task = tasksToProcess[i];
            const cachedItem = cachedList[i];
            if (cachedItem && cachedItem.hit && typeof cachedItem.score === "number") {
              extractAndBufferScoreResult(task.uniqueKey, cachedItem);
            } else {
              if (cachedItem?.isRead || cachedItem?.newsHash) {
                pendingReadSyncList.push({
                  uniqueKey: task.uniqueKey,
                  newsHash: cachedItem.newsHash || "",
                  isReadFromDb: Boolean(cachedItem.isRead),
                });
              }
              cacheMissTasks.push(task);
            }
          }

          // 一次性刷入该信源全部命中缓存的评分
          flushPendingScores();

          if (cacheMissTasks.length > 0 && runId === currentScoreRunId && !isAborted()) {
            scoreQueue.push(...cacheMissTasks);
            pendingQueueCount.value = scoreQueue.length;
            pumpScoreQueue(runId);
          }
        } catch {
          // 若后端尚未重启暂不支持 /score/cache，自动降级为走并发队列（配合帧缓冲同样高速）
          batchCacheSupported = false;
          if (runId === currentScoreRunId && !isAborted()) {
            scoreQueue.push(...tasksToProcess);
            pendingQueueCount.value = scoreQueue.length;
            pumpScoreQueue(runId);
          }
        } finally {
          activeCacheLookups.value = Math.max(0, activeCacheLookups.value - 1);
        }
      })();
      return;
    }

    scoreQueue.push(...tasksToProcess);
    pendingQueueCount.value = scoreQueue.length;
    pumpScoreQueue(runId);
  };

  const commitManualScore = async ({ item, newScore, newLayer }) => {
    const uniqueKey = item._uniqueKey;
    pendingScoreUpdates.delete(uniqueKey);
    const prevInfo = scoreMap[uniqueKey] ? { ...scoreMap[uniqueKey] } : null;

    if (prevInfo && prevInfo.score === newScore && prevInfo.isUserModified) {
      return;
    }

    // 乐观更新本地状态，随松开鼠标立刻重排生效
    scoreMap[uniqueKey] = {
      ...(prevInfo || {}),
      status: "done",
      score: newScore,
      layer: newLayer,
      isUserModified: true,
    };

    try {
      const res = await updateManualScore({
        newsHash: item._newsHash || prevInfo?.newsHash,
        title: item.title || "",
        desc: item.desc || "",
        source: item._sourceLabel || item._sourceName || "",
        url: item.url || item.mobileUrl || "",
        userScore: newScore,
        userLayer: newLayer,
      });

      const savedData = res?.data || res;
      if (savedData && typeof savedData.score === "number") {
        scoreMap[uniqueKey] = {
          ...(scoreMap[uniqueKey] || {}),
          status: "done",
          score: savedData.score,
          layer: savedData.layer || newLayer,
          reason: savedData.reason || prevInfo?.reason || "",
          newsHash: savedData.newsHash || prevInfo?.newsHash,
          isUserModified: true,
          fromCache: Boolean(savedData.fromCache ?? prevInfo?.fromCache),
          isRead: Boolean(savedData.isRead ?? prevInfo?.isRead ?? item._isRead),
        };
      }
      window.$message?.success(`已修正评分为 ${newScore} 分 (${newLayer})`);
    } catch (err) {
      console.error("保存手动评分修正失败:", err);
      if (prevInfo) {
        scoreMap[uniqueKey] = prevInfo;
      }
      window.$message?.error("保存手动评分失败");
    }
  };

  const cleanupScoring = () => {
    currentScoreRunId++;
    scoreQueue.length = 0;
    pendingQueueCount.value = 0;
    pendingScoreUpdates.clear();
    pendingReadSyncList.length = 0;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  return {
    MAX_SCORE_CONCURRENCY,
    scoreMap,
    activeScoreWorkers,
    pendingQueueCount,
    isScoring,
    getScoreRunId: () => currentScoreRunId,
    resetScoreQueue,
    pumpScoreQueue,
    enqueueSourceArticlesForScoring,
    commitManualScore,
    cleanupScoring,
  };
}

