<template>
  <n-card
    v-if="sources.length > 0"
    class="anchor-bar"
    size="small"
    :bordered="false"
  >
    <div class="source-nav">
      <div
        v-for="source in sources"
        :key="source.name"
        class="source-nav-tag"
        :class="{
          active: currentFilter === source.name,
          loading: loadingMap[source.name],
        }"
        @click="$emit('filter', source.name)"
      >
        <img
          :src="`/logo/${source.name}.png`"
          class="source-nav-logo"
          @error="(e) => (e.target.style.display = 'none')"
        />
        <span class="source-nav-label">{{ source.label }}</span>
        <span class="source-nav-count">
          {{
            loadingMap[source.name]
              ? "..."
              : dataMap[source.name]?.data?.length || 0
          }}
        </span>
      </div>
    </div>
  </n-card>
</template>

<script setup>
defineProps({
  sources: {
    type: Array,
    default: () => [],
  },
  currentFilter: {
    type: [String, null],
    default: null,
  },
  loadingMap: {
    type: Object,
    default: () => ({}),
  },
  dataMap: {
    type: Object,
    default: () => ({}),
  },
});

defineEmits(["filter"]);
</script>

<style lang="scss" scoped>
.anchor-bar {
  border-radius: 12px;
  background-color: var(--n-color);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);

  .source-nav {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;

    .source-nav-tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 16px;
      background-color: var(--n-border-color);
      font-size: 13px;
      cursor: pointer;
      transition: all 0.2s ease;
      user-select: none;

      .source-nav-logo {
        width: 16px;
        height: 16px;
        border-radius: 50%;
      }

      .source-nav-count {
        font-size: 11px;
        opacity: 0.7;
        background: rgba(0, 0, 0, 0.08);
        padding: 1px 6px;
        border-radius: 10px;
      }

      &:hover {
        opacity: 0.85;
        transform: translateY(-1px);
      }

      &.active {
        background-color: var(--n-color-primary, #18a058);
        color: #fff;

        .source-nav-count {
          background: rgba(255, 255, 255, 0.25);
          color: #fff;
        }
      }

      &.loading {
        animation: pulse 1.5s infinite;
      }
    }
  }
}

@keyframes pulse {
  0% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
  100% {
    opacity: 1;
  }
}
</style>
