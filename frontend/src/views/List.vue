<template>
  <div class="list">
    <n-space class="type" v-if="visibleSources.length > 0">
      <n-tag
        round
        size="large"
        class="tag"
        v-for="item in visibleSources"
        :key="item.key"
        :type="item.key === currentSourceKey ? 'primary' : 'default'"
        @click="changeType(item.key)"
      >
        {{ item.label }}
        <template #avatar>
          <img :src="resolveLogoUrl(item.logo)" :alt="item.label" class="logo" />
        </template>
      </n-tag>
    </n-space>
    <n-card class="card">
      <template #header>
        <Transition name="fade" mode="out-in">
          <template v-if="!listData">
            <div class="loading" style="height: 60px">
              <n-skeleton text round height="40px" />
            </div>
          </template>
          <template v-else>
            <div class="header">
              <div class="logo">
                <img :src="resolveLogoUrl(currentSource?.logo)" :alt="currentSource?.label" />
              </div>
              <div class="name">
                <n-text class="title">{{ listData.title }}</n-text>
                <n-text class="subtitle" :depth="3">
                  {{ listData.type || currentSource?.type || "" }}
                </n-text>
              </div>
              <div class="data">
                <n-text
                  v-if="listData.total !== undefined"
                  :depth="3"
                  class="total"
                  v-html="listData.total"
                />
                <n-text :depth="3" class="time" v-html="updateTime" />
              </div>
            </div>
          </template>
        </Transition>
      </template>
      <Transition name="fade" mode="out-in">
        <template v-if="!listData">
          <div class="loading" style="flex-direction: column">
            <n-skeleton
              text
              round
              :repeat="20"
              height="40px"
              style="margin-bottom: 20px"
            />
          </div>
        </template>
        <template v-else>
          <div class="all">
            <n-list hoverable clickable style="width: 100%">
              <n-list-item
                v-for="(item, index) in listData.data.slice(
                  pageNumber * 20 - 20,
                  pageNumber * 20
                )"
                :key="item.id || index"
                @click="jumpLink(item)"
              >
                <template #prefix>
                  <n-text
                    class="num"
                    :class="
                      index + 1 + (pageNumber - 1) * 20 === 1
                        ? 'one'
                        : index + 1 + (pageNumber - 1) * 20 === 2
                        ? 'two'
                        : index + 1 + (pageNumber - 1) * 20 === 3
                        ? 'three'
                        : null
                    "
                    :depth="2"
                  >
                    {{ index + 1 + (pageNumber - 1) * 20 }}
                  </n-text>
                </template>
                <div class="text">
                  <n-text class="title" v-html="item.title" />
                  <n-text
                    v-if="item.desc"
                    class="desc"
                    :depth="3"
                    v-html="item.desc"
                  />
                </div>
                <div class="message">
                  <div class="hot" v-if="item.hot">
                    <n-icon :depth="3" :component="Fire" />
                    <n-text class="hot-text" :depth="3" v-html="item.hot" />
                  </div>
                </div>
              </n-list-item>
            </n-list>
            <n-pagination
              class="pagination"
              :page-slot="5"
              :item-count="listData.data.length"
              :page-sizes="[20]"
              v-model:page="pageNumber"
            />
          </div>
        </template>
      </Transition>
    </n-card>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { Fire } from "@icon-park/vue-next";
import { mainStore } from "@/store";
import { useRouter } from "vue-router";
import { formatTime } from "@/utils/getTime";
import { getHotLists, resolveLogoUrl } from "@/api";

const router = useRouter();
const store = mainStore();

const visibleSources = computed(() => {
  return store.sources.filter((item) => Boolean(item.show));
});

const currentSourceKey = ref(
  router.currentRoute.value.query.type ||
    visibleSources.value[0]?.key ||
    store.sources[0]?.key ||
    ""
);

const currentSource = computed(() => {
  return store.sources.find((s) => s.key === currentSourceKey.value) || null;
});

const pageNumber = ref(
  router.currentRoute.value.query.page
    ? Number(router.currentRoute.value.query.page)
    : 1
);
const listData = ref(null);
const updateTime = ref(null);

const getHotListsData = async (sourceKey, isNew = false) => {
  listData.value = null;
  const item = store.sources.find((s) => s.key === sourceKey);
  if (!item) {
    if (store.sources.length > 0) {
      window.$message?.error("该分类不存在或已被移除");
    }
    return;
  }
  try {
    const res = await getHotLists(item, isNew);
    if (res && res.code === 200) {
      listData.value = res;
      updateTime.value = formatTime(res.updateTime);
    } else if (res && res.code === 404) {
      store.removeOfflineSource(item.key);
    } else {
      window.$message?.error(res?.message || "读取信源失败");
    }
  } catch (err) {
    const status = err?.response?.status;
    if (status === 404) {
      store.removeOfflineSource(item.key);
    } else {
      window.$message?.error("读取信源失败，请稍后重试");
    }
  }
};

const jumpLink = (data) => {
  if (!data.url && !data.mobileUrl) return window.$message?.error("链接不存在");
  const url = window.innerWidth > 680 ? data.url : data.mobileUrl;
  if (store.linkOpenType === "open") {
    window.open(url, "_blank");
  } else if (store.linkOpenType === "href") {
    window.location.href = url;
  }
};

const changeType = (key) => {
  currentSourceKey.value = key;
  router.push({
    path: "/list",
    query: {
      type: key,
      page: 1,
    },
  });
};

watch(
  () => store.timeData,
  () => {
    if (listData.value) {
      updateTime.value = formatTime(listData.value.updateTime);
    }
  }
);

watch(
  () => pageNumber.value,
  (val) => {
    router.push({
      path: "/list",
      query: {
        type: currentSourceKey.value,
        page: val,
      },
    });
    document.querySelector(".n-back-top")?.click();
  }
);

watch(
  () => router.currentRoute.value,
  (val) => {
    if (val.name === "list") {
      currentSourceKey.value = val.query.type;
      pageNumber.value = Number(val.query.page || 1);
      getHotListsData(currentSourceKey.value);
    }
  }
);

onMounted(async () => {
  if (store.sources.length === 0) {
    await store.loadSources();
  }
  if (!currentSourceKey.value) {
    currentSourceKey.value = visibleSources.value[0]?.key || store.sources[0]?.key || "";
  }
  if (currentSourceKey.value) {
    getHotListsData(currentSourceKey.value);
  }
});
</script>

<style lang="scss" scoped>
.list {
  .type {
    width: 100%;
    .tag {
      cursor: pointer;
      .logo {
        height: 22px;
        width: 22px;
        margin-left: 6px;
        border-radius: 50%;
      }
    }
  }
  .card {
    margin-top: 20px;
    border-radius: 8px;
    .fade-enter-active,
    .fade-leave-active {
      transition: opacity 0.3s ease-in-out;
    }

    .fade-enter-from,
    .fade-leave-to {
      opacity: 0;
    }
    .loading {
      display: flex;
      align-items: center;
    }
    :deep(.n-card__content) {
      @media (max-width: 740px) {
        padding: 0 12px 12px 12px;
      }
    }
    .header {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      align-items: center;
      justify-content: space-between;
      height: 60px;
      .logo {
        display: flex;
        align-items: center;
        img {
          height: 48px;
          width: 48px;
          border-radius: 10px;
          object-fit: cover;
        }
      }
      .name {
        display: flex;
        align-items: center;
        flex-direction: column;
        .title {
          font-size: 22px;
          font-weight: bold;
        }
        .subtitle {
          font-size: 14px;
        }
      }
      .data {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        font-size: 14px;
        .total {
          &::before {
            content: "共 ";
          }
          &::after {
            content: " 条 ·";
            margin-right: 6px;
          }
        }
      }
      @media (max-width: 740px) {
        display: flex;
        justify-content: flex-start;
        .logo {
          img {
            width: 32px;
            height: 32px;
          }
        }
        .name {
          margin-left: 12px;
          align-items: flex-end;
          flex-direction: row;
          .subtitle {
            margin-bottom: 3px;
            margin-left: 8px;
          }
        }
        .data {
          margin-left: auto;
        }
      }
    }
    .all {
      display: flex;
      flex-direction: column;
      align-items: center;
      .num {
        width: 24px;
        height: 24px;
        min-width: 24px;
        margin-right: 8px;
        font-size: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        background-color: var(--n-border-color);
        border-radius: 8px;
        transition: all 0.3s;
        &:hover {
          background-color: var(--n-close-color-hover);
        }
        &.one {
          background-color: #ea444d;
          color: #fff;
        }
        &.two {
          background-color: #ed702d;
          color: #fff;
        }
        &.three {
          background-color: #eead3f;
          color: #fff;
        }
      }
      .text {
        display: flex;
        flex-direction: column;
        .title {
          font-size: 16px;
          margin-bottom: 4px;
        }
        .desc {
          overflow: hidden;
          font-size: 14px;
          display: -webkit-inline-box;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 5;
        }
      }
      .message {
        display: flex;
        align-items: center;
        margin-top: 12px;
        .hot {
          display: flex;
          align-items: center;
          font-size: 13px;
          .hot-text {
            margin-left: 4px;
            line-height: 0;
          }
        }
      }
      .pagination {
        margin: 20px 0;
      }
      @media (max-width: 740px) {
        :deep(.n-list-item) {
          padding: 12px 10px;
          .n-list-item__prefix {
            margin-right: 12px;
          }
        }
      }
    }
  }
}
</style>
