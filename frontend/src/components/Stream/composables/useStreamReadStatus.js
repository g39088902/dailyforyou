import { reactive } from "vue";
import { mainStore } from "@/store";
import { markNewsRead, getReadNewsHashes } from "@/api";

export function useStreamReadStatus({ onReadStatusChange } = {}) {
  const store = mainStore();

  // displayedReadSet: 当前页面视口中“已生效打标为已读”的条目集合
  // 页面刚进入时加载历史已读数据，阅读过程中新读条目不立即加入此集合（不立即打标）
  // 直到页面下一次刷新/打开时，才在初始加载中将它们呈现在此集合中
  const displayedReadSet = reactive(
    new Set(Array.isArray(store.readNewsKeys) ? store.readNewsKeys : [])
  );

  // persistedReadSet: 包含历史已读和本次会话新读条目的完整集合，持久化到 Pinia 与 SQLite 后端
  const persistedReadSet = reactive(
    new Set(Array.isArray(store.readNewsKeys) ? store.readNewsKeys : [])
  );

  // sessionNewlyReadSet: 记录本次会话新读过但尚未在界面“打标”的条目
  const sessionNewlyReadSet = new Set();

  const articleMetaLookup = new Map();
  const pendingReadSyncMap = new Map();
  let readSyncTimer = null;
  let storeSyncTimer = null;

  let readObserver = null;
  const observedElementsMap = new Map();
  const visibilityTimersMap = new Map();
  const refSetterCache = new Map();

  const flushReadSetToStore = () => {
    if (storeSyncTimer) {
      clearTimeout(storeSyncTimer);
      storeSyncTimer = null;
    }
    const arr = Array.from(persistedReadSet);
    store.readNewsKeys = arr.length > 5000 ? arr.slice(arr.length - 5000) : arr;
  };

  const syncReadSetToStore = (immediate = false) => {
    if (immediate) {
      flushReadSetToStore();
      return;
    }
    if (storeSyncTimer) return;
    storeSyncTimer = setTimeout(() => {
      flushReadSetToStore();
    }, 300);
  };

  const flushReadSyncQueue = async () => {
    if (readSyncTimer) {
      clearTimeout(readSyncTimer);
      readSyncTimer = null;
    }
    if (pendingReadSyncMap.size === 0) return;

    const batchItems = Array.from(pendingReadSyncMap.values());
    pendingReadSyncMap.clear();

    try {
      const res = await markNewsRead({ items: batchItems });
      const savedList = Array.isArray(res?.data) ? res.data : [];
      let changed = false;
      savedList.forEach((record) => {
        if (record?.newsHash) {
          if (record.isRead) {
            if (!persistedReadSet.has(record.newsHash)) {
              persistedReadSet.add(record.newsHash);
              changed = true;
            }
            if (!sessionNewlyReadSet.has(record.newsHash) && !displayedReadSet.has(record.newsHash)) {
              displayedReadSet.add(record.newsHash);
            }
          } else {
            if (persistedReadSet.delete(record.newsHash)) {
              changed = true;
            }
            displayedReadSet.delete(record.newsHash);
          }
        }
      });
      if (changed) {
        syncReadSetToStore();
      }
    } catch (err) {
      console.warn("批量同步已读状态到后端失败:", err);
    }
  };

  const scheduleFlushReadSync = () => {
    if (readSyncTimer) return;
    readSyncTimer = setTimeout(() => {
      flushReadSyncQueue();
    }, 1000);
  };

  /**
   * 标记新闻为已读或未读
   * @param {Object} item 新闻数据对象
   * @param {Boolean} isRead 是否已读
   * @param {Boolean} fromUserAction 是否为用户手动显式操作（如手动点击已读标签取消已读）
   */
  const markArticleAsRead = (item, isRead = true, fromUserAction = false) => {
    if (!item || !item._uniqueKey) return;
    const uniqueKey = item._uniqueKey;
    const newsHash = item._newsHash || item.newsHash || "";

    if (isRead) {
      // 记录到持久化集合与本次新读集合
      if (!persistedReadSet.has(uniqueKey)) {
        persistedReadSet.add(uniqueKey);
      }
      sessionNewlyReadSet.add(uniqueKey);
      if (newsHash) {
        if (!persistedReadSet.has(newsHash)) {
          persistedReadSet.add(newsHash);
        }
        sessionNewlyReadSet.add(newsHash);
      }

      // 仅当用户主动显式操作时才在本次会话中立即打标
      // 用户正常阅读（视口停留或点击跳转），不马上打标，等到下一次刷新/打开才打标
      if (fromUserAction) {
        if (!displayedReadSet.has(uniqueKey)) {
          displayedReadSet.add(uniqueKey);
        }
        if (newsHash && !displayedReadSet.has(newsHash)) {
          displayedReadSet.add(newsHash);
        }
        onReadStatusChange?.(uniqueKey, true);
      }
    } else {
      // 用户主动取消已读（恢复为未读），立即生效
      sessionNewlyReadSet.delete(uniqueKey);
      displayedReadSet.delete(uniqueKey);
      persistedReadSet.delete(uniqueKey);
      if (newsHash) {
        sessionNewlyReadSet.delete(newsHash);
        displayedReadSet.delete(newsHash);
        persistedReadSet.delete(newsHash);
      }
      onReadStatusChange?.(uniqueKey, false);
    }

    syncReadSetToStore();

    pendingReadSyncMap.set(uniqueKey, {
      newsHash: newsHash || undefined,
      title: item.title || "",
      desc: item.desc || "",
      source: item._sourceLabel || item._sourceName || "",
      url: item.url || item.mobileUrl || "",
      isRead,
    });
    scheduleFlushReadSync();
  };

  // 手动点击标签切换已读状态（属于用户显式操作）
  const toggleReadStatus = (item, isRead) => {
    markArticleAsRead(item, isRead, true);
  };

  // 在重新加载全部信源（页面内刷新）时，将本次会话已读的内容正式并入已读展示集合
  const commitSessionReadToDisplayed = () => {
    sessionNewlyReadSet.forEach((key) => {
      if (!displayedReadSet.has(key)) {
        displayedReadSet.add(key);
      }
    });
    sessionNewlyReadSet.clear();
  };

  // 接收 AI 打分返回时附带的历史已读标记
  const handleScoreReadSync = ({ uniqueKey, newsHash, isReadFromDb }) => {
    let persistedChanged = false;
    if (isReadFromDb) {
      if (uniqueKey && !persistedReadSet.has(uniqueKey)) {
        persistedReadSet.add(uniqueKey);
        persistedChanged = true;
      }
      if (newsHash && !persistedReadSet.has(newsHash)) {
        persistedReadSet.add(newsHash);
        persistedChanged = true;
      }
      // 如果不是当前会话新读的，说明是历史记录，在当前会话中显示为已读
      if (!sessionNewlyReadSet.has(uniqueKey) && (!newsHash || !sessionNewlyReadSet.has(newsHash))) {
        if (uniqueKey && !displayedReadSet.has(uniqueKey)) {
          displayedReadSet.add(uniqueKey);
        }
        if (newsHash && !displayedReadSet.has(newsHash)) {
          displayedReadSet.add(newsHash);
        }
      }
      if (persistedChanged) {
        syncReadSetToStore();
      }
    } else if (
      persistedReadSet.has(uniqueKey) &&
      newsHash &&
      !persistedReadSet.has(newsHash)
    ) {
      persistedReadSet.add(newsHash);
      if (displayedReadSet.has(uniqueKey) && !displayedReadSet.has(newsHash)) {
        displayedReadSet.add(newsHash);
      }
      syncReadSetToStore();
    }
  };

  const initReadObserver = () => {
    if (typeof window === "undefined" || typeof IntersectionObserver === "undefined") {
      return;
    }
    readObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const uniqueKey = entry.target?.dataset?.uniqueKey;
          if (!uniqueKey) return;

          if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
            if (!visibilityTimersMap.has(uniqueKey)) {
              const timer = setTimeout(() => {
                visibilityTimersMap.delete(uniqueKey);
                const item = articleMetaLookup.get(uniqueKey);
                // 未曾记录过已读才触发，避免重复入队
                if (item && !persistedReadSet.has(uniqueKey)) {
                  markArticleAsRead(item, true, false);
                }
              }, 450);
              visibilityTimersMap.set(uniqueKey, timer);
            }
          } else {
            const timer = visibilityTimersMap.get(uniqueKey);
            if (timer) {
              clearTimeout(timer);
              visibilityTimersMap.delete(uniqueKey);
            }
          }
        });
      },
      {
        threshold: [0.5],
      }
    );

    observedElementsMap.forEach((el) => {
      readObserver.observe(el);
    });
  };

  const setArticleItemRef = (el, uniqueKey) => {
    if (!uniqueKey) return;
    const domEl = el?.$el || el;
    const prevEl = observedElementsMap.get(uniqueKey);

    if (domEl && domEl instanceof Element) {
      if (prevEl !== domEl) {
        if (prevEl && readObserver) {
          readObserver.unobserve(prevEl);
        }
        observedElementsMap.set(uniqueKey, domEl);
        if (readObserver) {
          readObserver.observe(domEl);
        }
      }
    } else {
      if (prevEl && readObserver) {
        readObserver.unobserve(prevEl);
      }
      observedElementsMap.delete(uniqueKey);
      const timer = visibilityTimersMap.get(uniqueKey);
      if (timer) {
        clearTimeout(timer);
        visibilityTimersMap.delete(uniqueKey);
      }
    }
  };

  // 为每个 uniqueKey 缓存稳定的 ref 绑定函数引用，避免重渲染时 Vue 反复以 null/el 触发 unobserve/observe
  const getArticleItemRefSetter = (uniqueKey) => {
    if (!uniqueKey) return undefined;
    let setter = refSetterCache.get(uniqueKey);
    if (!setter) {
      setter = (el) => setArticleItemRef(el, uniqueKey);
      refSetterCache.set(uniqueKey, setter);
    }
    return setter;
  };

  const cleanupReadObserver = () => {
    if (readObserver) {
      readObserver.disconnect();
      readObserver = null;
    }
    visibilityTimersMap.forEach((timer) => clearTimeout(timer));
    visibilityTimersMap.clear();
    observedElementsMap.clear();
    refSetterCache.clear();
    flushReadSetToStore();
    flushReadSyncQueue();
  };

  const loadReadHashesFromBackend = async () => {
    try {
      const res = await getReadNewsHashes(5000);
      const hashes = Array.isArray(res?.hashes)
        ? res.hashes
        : Array.isArray(res?.data)
          ? res.data
          : [];
      if (hashes.length > 0) {
        let changed = false;
        hashes.forEach((h) => {
          if (typeof h === "string" && h) {
            if (!persistedReadSet.has(h)) {
              persistedReadSet.add(h);
              changed = true;
            }
            // 只要不是本次会话新加入的，即视为历史已读并呈现在当前页面
            if (!sessionNewlyReadSet.has(h) && !displayedReadSet.has(h)) {
              displayedReadSet.add(h);
            }
          }
        });
        if (changed) {
          syncReadSetToStore();
        }
      }
    } catch (err) {
      console.warn("同步后端已读记录失败:", err);
    }
  };

  return {
    displayedReadSet,
    persistedReadSet,
    sessionNewlyReadSet,
    articleMetaLookup,
    syncReadSetToStore,
    flushReadSyncQueue,
    markArticleAsRead,
    toggleReadStatus,
    commitSessionReadToDisplayed,
    handleScoreReadSync,
    initReadObserver,
    cleanupReadObserver,
    setArticleItemRef,
    getArticleItemRefSetter,
    loadReadHashesFromBackend,
  };
}
