<template>
  <div>
    <!-- 底部加载进度条（当信源请求或 AI 评分未全部完成时展示） -->
    <div v-if="isLoading || isScoring" class="bottom-progress-panel">
      <div class="progress-info">
        <div class="info-left">
          <n-spin size="small" />
          <n-text v-if="isLoading" class="progress-text">
            正在获取：<strong class="current-label">{{ currentFetchingSourceLabel }}</strong>
            （已加载 {{ loadedSourcesCount }} / {{ sourceCount }} 个信源 · 已评分 {{ scoredNewsCount }} / {{ totalNewsCount }} 条）
          </n-text>
          <n-text v-else class="progress-text">
            正在进行 AI 个性化评分（已评分 <strong class="current-label">{{ scoredNewsCount }}</strong> / {{ totalNewsCount }} 条 ·
            并发数 {{ activeScoreWorkers }}/{{ maxScoreConcurrency }}）
          </n-text>
        </div>
        <n-text :depth="3" class="percentage-text">
          {{ isLoading ? progressPercentage : scoreProgressPercentage }}%
        </n-text>
      </div>
      <n-progress
        type="line"
        :percentage="isLoading ? progressPercentage : scoreProgressPercentage"
        :show-indicator="false"
        :status="isLoading ? 'info' : 'warning'"
        processing
      />
    </div>

    <!-- 全部加载完成提示 -->
    <div v-else-if="allArticlesCount > 0" class="completed-footer">
      <n-divider dashed>
        <n-text :depth="3">
          已加载全部 {{ sourceCount }} 个信源共 {{ totalNewsCount }} 条内容（已完成 AI 评分 {{ scoredNewsCount }} 条
          <template v-if="cachedScoreCount > 0">，其中 {{ cachedScoreCount }} 条来自缓存</template>
          <template v-if="readNewsCount > 0">，已阅读 {{ readNewsCount }} 条</template>）
        </n-text>
      </n-divider>
    </div>
  </div>
</template>

<script setup>
defineProps({
  isLoading: {
    type: Boolean,
    default: false,
  },
  isScoring: {
    type: Boolean,
    default: false,
  },
  currentFetchingSourceLabel: {
    type: String,
    default: "",
  },
  loadedSourcesCount: {
    type: Number,
    default: 0,
  },
  sourceCount: {
    type: Number,
    default: 0,
  },
  scoredNewsCount: {
    type: Number,
    default: 0,
  },
  totalNewsCount: {
    type: Number,
    default: 0,
  },
  activeScoreWorkers: {
    type: Number,
    default: 0,
  },
  maxScoreConcurrency: {
    type: Number,
    default: 5,
  },
  progressPercentage: {
    type: Number,
    default: 0,
  },
  scoreProgressPercentage: {
    type: Number,
    default: 0,
  },
  allArticlesCount: {
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
});
</script>

<style lang="scss" scoped>
.bottom-progress-panel {
  margin-top: 24px;
  padding: 16px 20px;
  border-radius: 10px;
  background-color: var(--n-color-modal, rgba(0, 0, 0, 0.03));
  border: 1px dashed var(--n-border-color);

  .progress-info {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;

    .info-left {
      display: flex;
      align-items: center;
      gap: 10px;

      .progress-text {
        font-size: 13px;

        .current-label {
          color: var(--n-color-primary, #18a058);
        }
      }
    }

    .percentage-text {
      font-size: 13px;
      font-weight: bold;
    }
  }
}

.completed-footer {
  margin-top: 32px;
  padding-bottom: 12px;
}
</style>
