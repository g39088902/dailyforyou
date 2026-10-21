import { defineStore } from "pinia";
import { getSources } from "@/api";

let retryTimer = null;
let retryAttempt = 0;

/**
 * 一次性迁移老版本 localStorage 中的 newsArr 用户偏好（开关与排序）
 */
const migrateLegacyPrefsIfNeeded = (currentPrefs) => {
  if (currentPrefs && Object.keys(currentPrefs).length > 0) {
    return currentPrefs;
  }
  try {
    const raw = localStorage.getItem("mainData");
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.newsArr) || parsed.newsArr.length === 0) {
      return {};
    }
    const migrated = {};
    parsed.newsArr.forEach((item, index) => {
      const k = item?.key || item?.name;
      if (k) {
        migrated[k] = {
          show: typeof item.show === "boolean" ? item.show : true,
          order: typeof item.order === "number" ? index : index,
        };
      }
    });
    return migrated;
  } catch {
    return {};
  }
};

export const mainStore = defineStore("mainData", {
  state: () => {
    return {
      // 系统主题
      siteTheme: "light",
      siteThemeAuto: true,

      // 用户对各信源的个性化偏好：{ [key]: { show: boolean, order: number } }
      sourcePrefs: {},
      // 上次成功从 GET /sources 获取的清单快照：{ etag: string, sources: Array }
      sourcesSnapshot: {
        etag: "",
        sources: [],
      },

      // 运行时合并后的信源列表（按用户排序排列）
      sources: [],
      // 信源清单加载状态：'idle' | 'loading' | 'ready' | 'degraded' | 'uninitialized'
      sourcesStatus: "idle",
      sourcesLoading: false,

      // 链接跳转方式
      linkOpenType: "open",
      // 页头固定
      headerFixed: true,
      // 时间数据
      timeData: null,
      // 字体大小
      listFontSize: 16,
      // 信息流是否隐藏已看过的内容
      hideReadNews: false,
      // 本地持久化的已读新闻标识集合（存 uniqueKey / newsHash）
      readNewsKeys: [],
      // 已读集合归属的用户 ID（切换账号时清空，避免跨账号串读）
      readNewsKeysOwner: null,
    };
  },
  getters: {},
  actions: {
    // 更改系统主题
    setSiteTheme(val) {
      window.$message?.info(
        `已切换至${val === "dark" ? "深色模式" : "浅色模式"}`,
        {
          showIcon: false,
        }
      );
      this.siteTheme = val;
      this.siteThemeAuto = false;
    },

    // 将 snapshot.sources 与用户 sourcePrefs 合并生成运行时 this.sources
    rebuildMergedSources() {
      const snapshotList = Array.isArray(this.sourcesSnapshot?.sources)
        ? this.sourcesSnapshot.sources
        : [];
      const prefs = this.sourcePrefs || {};

      this.sources = snapshotList
        .map((s) => {
          const pref = prefs[s.key];
          const defaultOrder = typeof s.order === "number" ? s.order : 0;
          const defaultShow = typeof s.defaultOn === "boolean" ? s.defaultOn : true;
          return {
            ...s,
            defaultOrder,
            show: typeof pref?.show === "boolean" ? pref.show : defaultShow,
            order: typeof pref?.order === "number" ? pref.order : defaultOrder,
          };
        })
        .sort((a, b) => {
          if (a.order !== b.order) return a.order - b.order;
          return String(a.key).localeCompare(String(b.key));
        });
    },

    // 从后端加载动态信源清单（支持两级降级与后台指数退避重试）
    async loadSources({ isRetry = false } = {}) {
      if (retryTimer && !isRetry) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }

      // 首次初始化时兼容读取旧版 localStorage 偏好
      this.sourcePrefs = migrateLegacyPrefsIfNeeded(this.sourcePrefs);

      // 若本地已有快照，先立即构建合并列表，让首屏零等待渲染
      if (
        Array.isArray(this.sourcesSnapshot?.sources) &&
        this.sourcesSnapshot.sources.length > 0 &&
        this.sources.length === 0
      ) {
        this.rebuildMergedSources();
      }

      this.sourcesLoading = true;
      try {
        const res = await getSources();
        if (res && res.code === 200) {
          if (res.initialized === false || !Array.isArray(res.sources) || res.sources.length === 0) {
            this.sources = [];
            this.sourcesStatus = "uninitialized";
            return false;
          }

          retryAttempt = 0;
          if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = null;
          }

          this.sourcesSnapshot = {
            etag: res.etag || "",
            sources: res.sources,
          };
          this.rebuildMergedSources();
          this.sourcesStatus = "ready";
          return true;
        }
        throw new Error(res?.message || "Invalid /sources response");
      } catch (err) {
        console.warn("拉取 /sources 清单失败:", err);
        const hasSnapshot =
          Array.isArray(this.sourcesSnapshot?.sources) &&
          this.sourcesSnapshot.sources.length > 0;

        if (hasSnapshot) {
          this.rebuildMergedSources();
          this.sourcesStatus = "degraded";
          this.scheduleBackgroundRetry();
          return true;
        } else {
          this.sources = [];
          this.sourcesStatus = "uninitialized";
          return false;
        }
      } finally {
        this.sourcesLoading = false;
      }
    },

    // 后台指数退避重试拉取 /sources
    scheduleBackgroundRetry() {
      if (retryTimer) return;
      retryAttempt = Math.min(retryAttempt + 1, 6);
      const delayMs = Math.min(3000 * Math.pow(2, retryAttempt - 1), 60000);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        this.loadSources({ isRetry: true });
      }, delayMs);
    },

    // 更新单个信源偏好
    setSourcePref(key, partialPref = {}) {
      if (!key) return;
      const prev = this.sourcePrefs[key] || {};
      this.sourcePrefs = {
        ...this.sourcePrefs,
        [key]: {
          ...prev,
          ...partialPref,
        },
      };
      this.rebuildMergedSources();
    },

    // 从设置页拖拽/开关同步完整的 sources 顺序与显隐到 sourcePrefs
    syncPrefsFromSources(newSourcesList) {
      if (!Array.isArray(newSourcesList)) return;
      const nextPrefs = { ...(this.sourcePrefs || {}) };
      newSourcesList.forEach((item, index) => {
        if (!item?.key) return;
        nextPrefs[item.key] = {
          show: Boolean(item.show),
          order: index,
        };
      });
      this.sourcePrefs = nextPrefs;
      this.rebuildMergedSources();
    },

    // 全选 / 全不选所有信源
    setAllSourcesShow(show) {
      const nextPrefs = { ...(this.sourcePrefs || {}) };
      this.sources.forEach((item, index) => {
        nextPrefs[item.key] = {
          show: Boolean(show),
          order: typeof item.order === "number" ? item.order : index,
        };
      });
      this.sourcePrefs = nextPrefs;
      this.rebuildMergedSources();
    },

    // 恢复默认排序与默认开关
    restoreDefaultSources() {
      this.sourcePrefs = {};
      this.rebuildMergedSources();
    },

    // 当某个信源请求返回 404 unknown source 时，将其从本地列表与快照移除并提示“信源已下线”
    removeOfflineSource(key) {
      if (!key) return;
      const target = this.sources.find((s) => s.key === key);
      this.sources = this.sources.filter((s) => s.key !== key);
      if (Array.isArray(this.sourcesSnapshot?.sources)) {
        this.sourcesSnapshot = {
          ...this.sourcesSnapshot,
          sources: this.sourcesSnapshot.sources.filter((s) => s.key !== key),
        };
      }
      if (this.sourcePrefs && this.sourcePrefs[key]) {
        const nextPrefs = { ...this.sourcePrefs };
        delete nextPrefs[key];
        this.sourcePrefs = nextPrefs;
      }
      window.$message?.warning(
        target?.label ? `信源「${target.label}」已下线` : "信源已下线"
      );
    },
  },
  persist: [
    {
      storage: localStorage,
      paths: [
        "siteTheme",
        "siteThemeAuto",
        "sourcePrefs",
        "sourcesSnapshot",
        "linkOpenType",
        "headerFixed",
        "listFontSize",
        "hideReadNews",
        "readNewsKeys",
        "readNewsKeysOwner",
      ],
    },
  ],
});
