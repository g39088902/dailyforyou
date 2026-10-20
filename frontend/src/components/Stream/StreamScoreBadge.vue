<template>
  <div
    v-if="typeof item._score === 'number'"
    class="score-interactive-wrap"
    :title="getScoreTooltip(item)"
    @mouseenter="isHovered = true"
    @mouseleave="handleMouseLeave"
    @click.stop
    @mousedown.stop
  >
    <!-- 悬浮或拖拽态：可拖动进度条 -->
    <div
      v-if="isHovered || isDragging"
      :class="['score-progress-slider', getScoreClass(displayScore)]"
    >
      <div
        class="score-progress-fill"
        :style="{ width: `${displayScore}%` }"
      />
      <span class="score-progress-label">
        {{ displayScore }}分 · {{ getLayerByScore(displayScore) }}
      </span>
      <input
        type="range"
        min="0"
        max="100"
        step="1"
        class="score-range-input"
        :value="displayScore"
        @mousedown.stop="handleDragStart"
        @touchstart.stop="handleDragStart"
        @input="handleInput"
        @change="handleCommit"
        @click.stop
      />
    </div>

    <!-- 默认态：分数胶囊 Tag -->
    <n-tag
      v-else
      size="small"
      round
      :bordered="false"
      :class="[
        'score-tag',
        getScoreClass(item._score),
        {
          'user-modified': item._isUserModified,
          'from-cache': item._fromCache && !item._isUserModified,
        },
      ]"
    >
      {{ item._score }}分
      <span v-if="item._layer" class="score-layer">· {{ item._layer }}</span>
      <span
        v-if="item._fromCache"
        class="cache-badge"
        title="AI评分来自SQLite本地缓存（未重复消耗Token）"
      >
        ⚡缓存
      </span>
      <span v-if="item._isUserModified" class="manual-dot" title="已手动修正">✎</span>
    </n-tag>
  </div>
  <n-tag
    v-else-if="item._scoreStatus === 'scoring'"
    size="small"
    round
    :bordered="false"
    class="score-tag scoring"
  >
    评分中...
  </n-tag>
</template>

<script setup>
import { ref, computed } from "vue";
import { getScoreClass, getLayerByScore, getScoreTooltip } from "./utils/scoreUtils";

const props = defineProps({
  item: {
    type: Object,
    required: true,
  },
});

const emit = defineEmits(["commit"]);

const isHovered = ref(false);
const isDragging = ref(false);
const previewScore = ref(null);

const displayScore = computed(() => {
  if (typeof previewScore.value === "number") {
    return previewScore.value;
  }
  return typeof props.item._score === "number" ? props.item._score : 0;
});

const handleMouseLeave = () => {
  isHovered.value = false;
  if (!isDragging.value) {
    previewScore.value = null;
  }
};

const handleDragStart = () => {
  isDragging.value = true;
  if (typeof props.item._score === "number") {
    previewScore.value = props.item._score;
  }
};

const handleInput = (event) => {
  const val = Math.max(0, Math.min(100, Math.round(Number(event.target.value))));
  isDragging.value = true;
  previewScore.value = val;
};

const handleCommit = (event) => {
  const newScore = Math.max(0, Math.min(100, Math.round(Number(event.target.value))));
  const newLayer = getLayerByScore(newScore);

  isDragging.value = false;
  previewScore.value = null;

  emit("commit", {
    item: props.item,
    newScore,
    newLayer,
  });
};
</script>

<style lang="scss" scoped>
.score-interactive-wrap {
  display: inline-flex;
  align-items: center;
  height: 22px;
}

.score-progress-slider {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 146px;
  height: 22px;
  border-radius: 11px;
  overflow: hidden;
  background: rgba(128, 128, 128, 0.14);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08);
  user-select: none;
  cursor: ew-resize;

  .score-progress-fill {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    border-radius: 11px 0 0 11px;
    transition: width 0.03s linear, background-color 0.15s ease;
  }

  .score-progress-label {
    position: relative;
    z-index: 1;
    font-size: 12px;
    font-weight: 600;
    line-height: 22px;
    padding: 0 8px;
    white-space: nowrap;
    pointer-events: none;
  }

  .score-range-input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    opacity: 0;
    cursor: ew-resize;
    z-index: 2;
  }

  &.score-l1 {
    background: rgba(234, 68, 68, 0.1);
    color: #b31412;
    .score-progress-fill {
      background: rgba(234, 68, 68, 0.32);
    }
  }

  &.score-l2 {
    background: rgba(240, 138, 0, 0.1);
    color: #ad4e00;
    .score-progress-fill {
      background: rgba(240, 138, 0, 0.32);
    }
  }

  &.score-l4 {
    background: rgba(24, 160, 88, 0.1);
    color: #0e7a43;
    .score-progress-fill {
      background: rgba(24, 160, 88, 0.32);
    }
  }

  &.score-neutral {
    background: rgba(32, 128, 240, 0.1);
    color: #1060c9;
    .score-progress-fill {
      background: rgba(32, 128, 240, 0.3);
    }
  }

  &.score-l5 {
    background: rgba(128, 128, 128, 0.1);
    color: #555;
    .score-progress-fill {
      background: rgba(128, 128, 128, 0.3);
    }
  }
}

.score-tag {
  font-size: 12px;
  font-weight: 600;
  height: 22px;
  line-height: 22px;
  padding: 0 8px;
  cursor: pointer;

  .score-layer {
    font-weight: 500;
    opacity: 0.9;
    margin-left: 2px;
  }

  .cache-badge {
    margin-left: 4px;
    padding: 0 4px;
    font-size: 10px;
    font-weight: 500;
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.06);
    opacity: 0.85;
  }

  .manual-dot {
    margin-left: 3px;
    font-size: 11px;
    opacity: 0.85;
  }

  &.user-modified {
    box-shadow: inset 0 0 0 1px currentColor;
  }

  &.from-cache {
    box-shadow: inset 0 0 0 1px rgba(128, 128, 128, 0.22);
  }

  &.score-l1 {
    background: rgba(234, 68, 68, 0.14);
    color: #d93025;
  }

  &.score-l2 {
    background: rgba(240, 138, 0, 0.14);
    color: #d46b08;
  }

  &.score-l4 {
    background: rgba(24, 160, 88, 0.14);
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

  &.scoring {
    background: rgba(240, 160, 32, 0.1);
    color: #d48806;
    font-weight: 400;
    cursor: default;
  }
}
</style>
