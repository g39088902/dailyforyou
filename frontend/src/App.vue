<template>
  <Provider>
    <n-layout
      embedded
      :native-scrollbar="false"
      :class="[isStreamPage ? 'stream-layout' : null]"
    >
      <n-back-top :visibility-height="300" />
      <Header v-if="!isStreamPage" />
      <main>
        <router-view v-slot="{ Component }">
          <keep-alive>
            <transition name="scale" mode="out-in">
              <component :is="Component" />
            </transition>
          </keep-alive>
        </router-view>
      </main>
      <Footer />
    </n-layout>
    <LoginModal />
  </Provider>
</template>

<script setup>
import { computed, nextTick, onMounted } from "vue";
import { useRoute } from "vue-router";
import { mainStore } from "@/store";
import { useAuthStore } from "@/store/auth";
import { AUTH_EVENTS, emitAuthEvent } from "@/utils/authEvents";
import Provider from "@/components/Provider.vue";
import Header from "@/components/Header.vue";
import Footer from "@/components/Footer.vue";
import LoginModal from "@/components/Auth/LoginModal.vue";

const route = useRoute();
const store = mainStore();
const authStore = useAuthStore();
store.loadSources();

const isStreamPage = computed(() => route.path === "/stream" || route.path === "/");

onMounted(() => {
  // 未登录状态打开网页时，默认弹窗引导用户登录（可关闭）
  if (!authStore.isAuthed) {
    nextTick(() => {
      emitAuthEvent(AUTH_EVENTS.OPEN_LOGIN);
    });
  }
});
</script>

<style lang="scss" scoped>
.n-layout {
  height: 100%;
  &.stream-layout {
    main {
      padding: 24px 5vw 0 5vw;
      min-height: calc(100vh - 120px);
    }
  }
  :deep(.n-scrollbar-rail) {
    right: 0;
    top: 0;
    bottom: 0;
    z-index: 101;
  }
  main {
    padding: 20px 5vw;
    max-width: 1800px;
    margin: 0 auto;
    min-height: calc(100vh - 200px);
  }
}

// 路由跳转动画
.scale-enter-active,
.scale-leave-active {
  transition: all 0.2s ease;
}

.scale-enter-from,
.scale-leave-to {
  opacity: 0;
  transform: scale(0.98);
}
</style>
