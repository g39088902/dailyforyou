<template>
  <n-card
    :bordered="false"
    :class="[
      'header',
      {
        'is-fixed': store.headerFixed,
        'is-scrolled': isScrolled,
      },
    ]"
    content-style="padding: 0"
  >
    <section>
      <div class="logo" @click="router.push('/')">
        <img src="/ico/favicon.png" alt="logo" />
        <div class="name">
          <n-text>今日热榜</n-text>
          <n-text v-if="!isScrolled" :depth="3">汇聚全网热点，热门尽览无余</n-text>
        </div>
      </div>
      <div class="current-time">
        <StreamClock :compact="isScrolled" />
      </div>
      <div class="controls">
        <n-space justify="end">
          <n-popover v-if="showRefresh">
            <template #trigger>
              <n-button secondary strong round @click="router.go(0)">
                <template #icon>
                  <n-icon :component="Refresh" />
                </template>
              </n-button>
            </template>
            刷新页面
          </n-popover>
          <n-popover>
            <template #trigger>
              <n-button
                secondary
                strong
                round
                @click="
                  store.setSiteTheme(
                    store.siteTheme === 'light' ? 'dark' : 'light'
                  )
                "
              >
                <template #icon>
                  <n-icon
                    :component="store.siteTheme === 'light' ? Moon : SunOne"
                  />
                </template>
              </n-button>
            </template>
            {{ store.siteTheme === "light" ? "深色模式" : "浅色模式" }}
          </n-popover>
          <n-popover>
            <template #trigger>
              <n-button
                secondary
                strong
                round
                @click="router.push('/')"
              >
                <template #icon>
                  <n-icon :component="ViewList" />
                </template>
              </n-button>
            </template>
            聚合首页
          </n-popover>
          <n-popover>
            <template #trigger>
              <n-button secondary strong round @click="router.push('/setting')">
                <template #icon>
                  <n-icon :component="SettingTwo" />
                </template>
              </n-button>
            </template>
            全局设置
          </n-popover>
          <AccountEntry />
        </n-space>
      </div>
      <div class="mobile">
        <n-dropdown
          :options="menuOptions"
          size="large"
          trigger="click"
          placement="bottom-end"
          @select="menuOptionsSelect"
        >
          <n-button secondary strong round>
            <template #icon>
              <n-icon :component="HamburgerButton" />
            </template>
          </n-button>
        </n-dropdown>
      </div>
    </section>
  </n-card>
</template>

<script setup>
import {
  SunOne,
  Moon,
  Refresh,
  SettingTwo,
  HamburgerButton,
  ViewList,
} from "@icon-park/vue-next";
import StreamClock from "@/components/Stream/StreamClock.vue";
import AccountEntry from "@/components/Auth/AccountEntry.vue";
import { getCurrentTime } from "@/utils/getTime.js";
import { mainStore } from "@/store";
import { NText, NIcon } from "naive-ui";
import { useRouter } from "vue-router";
import { ref, watch, onMounted, onBeforeUnmount, nextTick, h } from "vue";

const router = useRouter();
const store = mainStore();
const timeInterval = ref(null);
const showRefresh = ref(false);
const isScrolled = ref(false);

const handleScroll = (e) => {
  const scrollTop =
    e?.target?.scrollTop ??
    document.querySelector(".n-layout-scroll-container")?.scrollTop ??
    window.scrollY ??
    0;
  isScrolled.value = scrollTop > 15;
};

let scrollContainer = null;

const bindScrollListener = () => {
  scrollContainer = document.querySelector(".n-layout-scroll-container");
  if (scrollContainer) {
    scrollContainer.removeEventListener("scroll", handleScroll);
    scrollContainer.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll({ target: scrollContainer });
  }
  window.removeEventListener("scroll", handleScroll);
  window.addEventListener("scroll", handleScroll, { passive: true });
};

// 移动端时间模块
const timeRender = () => {
  return h(
    "div",
    {
      style: {
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        padding: "8px 12px",
      },
    },
    [h(StreamClock, { compact: true })]
  );
};

// 移动端菜单
const menuOptions = [
  {
    key: "header",
    type: "render",
    render: timeRender,
  },
  {
    key: "header-divider",
    type: "divider",
  },
  {
    label: "刷新页面",
    key: "refresh",
    icon: () => {
      return h(NIcon, null, {
        default: () => h(Refresh),
      });
    },
  },
  {
    label: () => {
      return h(NText, null, {
        default: () => (store.siteTheme === "light" ? "深色模式" : "浅色模式"),
      });
    },
    key: "changeTheme",
    icon: () => {
      return h(NIcon, null, {
        default: () => (store.siteTheme === "light" ? h(Moon) : h(SunOne)),
      });
    },
  },
  {
    label: "全网聚合",
    key: "stream",
    icon: () => {
      return h(NIcon, null, {
        default: () => h(ViewList),
      });
    },
  },
  {
    label: "全局设置",
    key: "setting",
    icon: () => {
      return h(NIcon, null, {
        default: () => h(SettingTwo),
      });
    },
  },
  {
    label: "账户与 Prompt",
    key: "account",
    icon: () => {
      return h(NIcon, null, {
        default: () => h(ViewList),
      });
    },
  },
];

// 移动端下拉菜单点击事件
const menuOptionsSelect = (val) => {
  if (val === "refresh") {
    router.go(0);
  } else if (val === "changeTheme") {
    store.setSiteTheme(store.siteTheme === "light" ? "dark" : "light");
  } else if (val === "stream") {
    router.push("/");
  } else if (val === "setting") {
    router.push("/setting");
  } else if (val === "account") {
    router.push("/account");
  }
};

// 监听路由参数变化
watch(
  () => router.currentRoute.value,
  (val) => {
    const isHome = val.path === "/";
    showRefresh.value = isHome ? true : false;
    nextTick(() => {
      bindScrollListener();
    });
  }
);

onMounted(() => {
  window.$timeInterval = timeInterval.value = setInterval(() => {
    store.timeData = getCurrentTime();
  }, 1000);
  showRefresh.value = router.currentRoute.value?.path === "/" ? true : false;
  nextTick(() => {
    bindScrollListener();
  });
});

onBeforeUnmount(() => {
  clearInterval(timeInterval.value);
  if (scrollContainer) {
    scrollContainer.removeEventListener("scroll", handleScroll);
  }
  window.removeEventListener("scroll", handleScroll);
});
</script>

<style lang="scss" scoped>
.header {
  height: 92px;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  padding: 0 5vw;
  box-sizing: border-box;
  background-color: var(--n-color);
  border-bottom: 1px solid transparent;
  transition: height 0.25s ease, background-color 0.25s ease, box-shadow 0.25s ease, border-color 0.25s ease;

  &.is-fixed {
    position: sticky;
    top: 0;
    z-index: 100;
  }

  &.is-scrolled {
    height: 64px;
    background-color: var(--n-color);
    border-bottom-color: var(--n-border-color);
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.05);

    section {
      .logo {
        img {
          width: 36px;
          height: 36px;
        }
        .name {
          span:nth-of-type(1) {
            font-size: 17px;
          }
        }
      }
    }
  }

  section {
    width: 100%;
    max-width: 1800px;
    margin: 0 auto;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    align-items: center;
    justify-content: space-between;

    .logo {
      display: flex;
      flex-direction: row;
      align-items: center;
      cursor: pointer;
      user-select: none;
      img {
        width: 44px;
        height: 44px;
        margin-right: 14px;
        transition: all 0.25s ease;
      }
      .name {
        display: flex;
        flex-direction: column;
        span {
          &:nth-of-type(1) {
            font-size: 19px;
            font-weight: bold;
            transition: all 0.25s ease;
          }
          &:nth-of-type(2) {
            font-size: 12px;
            margin-top: 2px;
          }
        }
      }
    }

    .current-time {
      display: flex;
      justify-content: center;
      align-items: center;
      transition: all 0.25s ease;
    }

    .mobile {
      display: none;
    }

    @media (max-width: 768px) {
      display: flex;
      .logo {
        img {
          width: 36px;
          height: 36px;
        }
        .name {
          span {
            &:nth-of-type(1) {
              font-size: 17px;
            }
          }
        }
      }
      .current-time,
      .controls {
        display: none;
      }
      .mobile {
        display: block;
      }
    }
  }
}
</style>
