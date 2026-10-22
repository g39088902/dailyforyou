<template>
  <div class="user-score-records">
    <div class="toolbar">
      <div class="toolbar-left">
        <n-text :depth="3" class="count-tip">
          共 <span class="highlight">{{ total }}</span> 条手动调整记录
        </n-text>
      </div>
      <div class="toolbar-right">
        <n-input
          v-model:value="searchKeyword"
          size="small"
          placeholder="搜索新闻标题或理由..."
          clearable
          class="search-input"
          @keyup.enter="handleSearch"
          @clear="handleSearch"
        >
          <template #prefix>
            <n-icon><Search /></n-icon>
          </template>
        </n-input>
        <n-button size="small" secondary :loading="loading" @click="fetchRecords">
          <template #icon>
            <n-icon><Refresh /></n-icon>
          </template>
          刷新
        </n-button>
      </div>
    </div>

    <!-- 加载骨架 -->
    <div v-if="loading && records.length === 0" class="skeleton-wrap">
      <n-skeleton text :repeat="3" />
      <n-divider />
      <n-skeleton text :repeat="3" />
    </div>

    <!-- 空状态 -->
    <n-empty
      v-else-if="records.length === 0"
      :description="searchKeyword ? '未找到匹配的手动调整记录' : '暂无手动调整过的新闻记录，在情报流中拖动分数滑块即可沉淀偏好'"
      class="empty-box"
    >
      <template #extra v-if="searchKeyword">
        <n-button size="small" quaternary @click="clearSearch">清空搜索条件</n-button>
      </template>
    </n-empty>

    <!-- 记录列表 -->
    <div v-else class="records-list">
      <div
        v-for="item in records"
        :key="item.id || item.newsHash"
        class="record-item"
      >
        <!-- 头部：信源、标题、状态 -->
        <div class="item-head">
          <n-tag size="small" :bordered="false" class="source-tag">
            {{ getSourceTitle(item.source) }}
          </n-tag>
          <a
            :href="item.url || 'javascript:;'"
            :target="item.url ? '_blank' : '_self'"
            rel="noopener noreferrer"
            class="title-link"
            :title="item.title"
          >
            {{ item.title || "（无标题新闻）" }}
          </a>
          <n-tag v-if="item.isRead" size="tiny" :bordered="false" class="read-tag">
            已读
          </n-tag>
        </div>

        <!-- 分数对比：AI 原始 -> 用户手动 -->
        <div class="score-compare">
          <div class="score-pill ai">
            <span class="pill-label">AI 初评:</span>
            <span class="pill-val">{{ item.aiScore >= 0 ? `${item.aiScore}分` : '未评分' }}</span>
            <span v-if="item.aiLayer" class="pill-layer">({{ item.aiLayer }})</span>
          </div>

          <span class="arrow">→</span>

          <div :class="['score-pill user', getScoreClass(item.userScore)]">
            <span class="pill-label">手动调整:</span>
            <span class="pill-val">{{ item.userScore }}分</span>
            <span v-if="item.userLayer" class="pill-layer">({{ item.userLayer }})</span>
          </div>
        </div>

        <!-- 理由展示 -->
        <div v-if="item.userReason || item.aiReason" class="reason-box">
          <div v-if="item.userReason" class="reason-row user">
            <span class="reason-prefix">用户备注：</span>
            <span class="reason-text">{{ item.userReason }}</span>
          </div>
          <div v-if="item.aiReason" class="reason-row ai">
            <span class="reason-prefix">AI 理由：</span>
            <span class="reason-text">{{ item.aiReason }}</span>
          </div>
        </div>

        <!-- 底部栏：时间与操作 -->
        <div class="item-foot">
          <div class="time-meta">
            <n-text :depth="3">
              调整时间: {{ formatDate(item.userUpdatedAt || item.updatedAt) }}
            </n-text>
          </div>

          <n-space align="center" :size="8">
            <!-- 快速重新微调 -->
            <n-popover trigger="click" placement="top" :show-arrow="false">
              <template #trigger>
                <n-button size="tiny" secondary>微调分数</n-button>
              </template>
              <div class="quick-adjust-popover">
                <div class="popover-title">微调分数 (当前: {{ item.userScore }}分)</div>
                <div class="editor-box">
                  <div class="slider-row">
                    <n-slider
                      :value="activeEditScore[item.id] ?? item.userScore"
                      :min="0"
                      :max="100"
                      :step="1"
                      @update:value="(v) => (activeEditScore[item.id] = v)"
                    />
                    <span class="slider-num">
                      {{ activeEditScore[item.id] ?? item.userScore }}分 · {{ getLayerByScore(activeEditScore[item.id] ?? item.userScore) }}
                    </span>
                  </div>
                  <div class="btn-row">
                    <n-button
                      size="tiny"
                      type="primary"
                      :loading="adjustingId === item.id"
                      @click="handleQuickAdjust(item, activeEditScore[item.id] ?? item.userScore)"
                    >
                      保存
                    </n-button>
                  </div>
                </div>
              </div>
            </n-popover>

            <!-- 重置为 AI 评分 -->
            <n-popconfirm
              @positive-click="handleResetScore(item)"
              positive-text="确认重置"
              negative-text="取消"
            >
              <template #trigger>
                <n-button
                  size="tiny"
                  quaternary
                  type="error"
                  :loading="resettingId === item.id"
                >
                  恢复AI打分
                </n-button>
              </template>
              确认重置该条记录，恢复为 AI 原始打分（{{ item.aiScore }}分）？
            </n-popconfirm>
          </n-space>
        </div>
      </div>
    </div>

    <!-- 分页器 -->
    <div v-if="total > 0" class="pagination-wrap">
      <n-pagination
        v-model:page="page"
        v-model:page-size="pageSize"
        :item-count="total"
        :page-sizes="[10, 20, 50]"
        show-size-picker
        show-quick-jumper
        @update:page="handlePageChange"
        @update:page-size="handlePageSizeChange"
      />
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from "vue";
import { Refresh, Search } from "@icon-park/vue-next";
import { mainStore } from "@/store";
import { getUserModifiedRecords, resetManualScore, updateManualScore } from "@/api";
import { getScoreClass, getLayerByScore } from "@/components/Stream/utils/scoreUtils";

const store = mainStore();

const records = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const searchKeyword = ref("");
const loading = ref(false);
const resettingId = ref(null);
const adjustingId = ref(null);
const activeEditScore = reactive({});

const formatDate = (value) => {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
};

const getSourceTitle = (sourceKey) => {
  if (!sourceKey) return "全网";
  const matched = (store.sources || []).find(
    (s) => s.name === sourceKey || s.key === sourceKey
  );
  return matched?.title || sourceKey;
};

const fetchRecords = async () => {
  loading.value = true;
  try {
    const res = await getUserModifiedRecords({
      page: page.value,
      pageSize: pageSize.value,
      keyword: searchKeyword.value.trim() || undefined,
    });
    if (res?.code === 200) {
      records.value = Array.isArray(res.data) ? res.data : [];
      total.value = Number(res.total || 0);
    } else {
      window.$message?.error(res?.message || "获取调整记录失败");
    }
  } catch (error) {
    console.error("加载调整记录失败:", error);
    window.$message?.error("加载调整记录失败，请检查网络");
  } finally {
    loading.value = false;
  }
};

const handleSearch = () => {
  page.value = 1;
  fetchRecords();
};

const clearSearch = () => {
  searchKeyword.value = "";
  page.value = 1;
  fetchRecords();
};

const handlePageChange = (p) => {
  page.value = p;
  fetchRecords();
};

const handlePageSizeChange = (ps) => {
  pageSize.value = ps;
  page.value = 1;
  fetchRecords();
};

const handleResetScore = async (item) => {
  resettingId.value = item.id;
  try {
    const res = await resetManualScore({
      id: item.id,
      newsHash: item.newsHash,
    });
    if (res?.code === 200) {
      window.$message?.success("已恢复为 AI 原始打分");
      // 刷新列表
      await fetchRecords();
    } else {
      window.$message?.error(res?.message || "重置失败");
    }
  } catch (error) {
    window.$message?.error("重置失败，请重试");
  } finally {
    resettingId.value = null;
  }
};

const handleQuickAdjust = async (item, newScore) => {
  adjustingId.value = item.id;
  try {
    const res = await updateManualScore({
      id: item.id,
      newsHash: item.newsHash,
      title: item.title,
      source: item.source,
      url: item.url,
      userScore: newScore,
      userLayer: getLayerByScore(newScore),
    });
    if (res?.code === 200) {
      window.$message?.success(`已更新为 ${newScore} 分`);
      // 局部更新记录状态
      item.userScore = newScore;
      item.userLayer = getLayerByScore(newScore);
      item.userUpdatedAt = new Date().toISOString();
    } else {
      window.$message?.error(res?.message || "更新失败");
    }
  } catch (error) {
    window.$message?.error("微调更新失败");
  } finally {
    adjustingId.value = null;
  }
};

onMounted(() => {
  fetchRecords();
});

defineExpose({
  fetchRecords,
});
</script>

<style lang="scss" scoped>
.user-score-records {
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
    gap: 16px;
    flex-wrap: wrap;

    .toolbar-left {
      .count-tip {
        font-size: 13px;
        .highlight {
          color: var(--n-text-color-base, #18a058);
          font-weight: 600;
        }
      }
    }

    .toolbar-right {
      display: flex;
      align-items: center;
      gap: 10px;

      .search-input {
        width: 240px;
      }
    }
  }

  .skeleton-wrap {
    padding: 20px 0;
  }

  .empty-box {
    padding: 36px 0;
  }

  .records-list {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .record-item {
    padding: 14px 16px;
    border-radius: 8px;
    background: rgba(128, 128, 128, 0.05);
    border: 1px solid rgba(128, 128, 128, 0.12);
    display: flex;
    flex-direction: column;
    gap: 10px;
    transition: all 0.2s ease;

    &:hover {
      background: rgba(128, 128, 128, 0.08);
      border-color: rgba(128, 128, 128, 0.2);
    }

    .item-head {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;

      .source-tag {
        font-size: 11px;
        font-weight: 500;
      }

      .title-link {
        color: inherit;
        text-decoration: none;
        font-size: 15px;
        font-weight: 600;
        line-height: 1.4;
        flex: 1;
        min-width: 200px;
        word-break: break-all;

        &:hover {
          color: #18a058;
          text-decoration: underline;
        }
      }

      .read-tag {
        font-size: 11px;
        opacity: 0.6;
      }
    }

    .score-compare {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      font-size: 12px;

      .arrow {
        opacity: 0.4;
        font-weight: bold;
      }

      .score-pill {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 10px;
        border-radius: 12px;
        font-size: 12px;

        &.ai {
          background: rgba(128, 128, 128, 0.12);
          color: inherit;
          opacity: 0.8;
        }

        &.user {
          font-weight: 600;

          &.score-l1 {
            background: rgba(234, 68, 68, 0.12);
            color: #d03050;
          }
          &.score-l2 {
            background: rgba(240, 138, 0, 0.12);
            color: #f0a020;
          }
          &.score-l4 {
            background: rgba(24, 160, 88, 0.12);
            color: #18a058;
          }
          &.score-neutral {
            background: rgba(32, 128, 240, 0.12);
            color: #2080f0;
          }
          &.score-l5 {
            background: rgba(128, 128, 128, 0.12);
            color: #888;
          }
        }

        .pill-label {
          opacity: 0.7;
          font-size: 11px;
        }

        .pill-val {
          font-weight: bold;
        }

        .pill-layer {
          font-size: 11px;
          opacity: 0.85;
        }
      }
    }

    .reason-box {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
      padding: 8px 10px;
      border-radius: 6px;
      background: rgba(128, 128, 128, 0.04);

      .reason-row {
        line-height: 1.5;
        .reason-prefix {
          font-weight: 500;
          opacity: 0.7;
        }
        .reason-text {
          word-break: break-all;
        }
      }
    }

    .item-foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-size: 12px;
      padding-top: 4px;
      border-top: 1px dashed rgba(128, 128, 128, 0.15);
    }
  }

  .pagination-wrap {
    display: flex;
    justify-content: flex-end;
    margin-top: 20px;
  }
}

.quick-adjust-popover {
  padding: 8px 4px;
  width: 240px;

  .popover-title {
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 8px;
  }
}

.editor-box {
  display: flex;
  flex-direction: column;
  gap: 8px;

  .slider-row {
    display: flex;
    align-items: center;
    gap: 8px;

    :deep(.n-slider) {
      flex: 1;
    }

    .slider-num {
      font-size: 11px;
      white-space: nowrap;
      min-width: 75px;
      text-align: right;
    }
  }

  .btn-row {
    display: flex;
    justify-content: flex-end;
  }
}

@media (max-width: 768px) {
  .user-score-records {
    .toolbar {
      flex-direction: column;
      align-items: stretch;

      .toolbar-right {
        .search-input {
          flex: 1;
        }
      }
    }

    .record-item {
      .item-foot {
        flex-direction: column;
        align-items: flex-start;
        gap: 8px;
      }
    }

    .pagination-wrap {
      justify-content: center;
    }
  }
}
</style>