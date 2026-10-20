import { createApp } from "vue";
import { createPinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";

import App from "./App.vue";
import router from "@/router";
import { useAuthStore } from "@/store/auth";
import { AUTH_EVENTS, onAuthEvent } from "@/utils/authEvents";

// 全局样式
import "@/style/global.scss";

const app = createApp(App);

const pinia = createPinia();
pinia.use(piniaPluginPersistedstate);
app.use(pinia);
app.use(router);

const authStore = useAuthStore();
authStore.hydrate();

// 令牌失效时统一清理登录态（request.js 只负责删本地存储并广播事件）
onAuthEvent(AUTH_EVENTS.UNAUTHORIZED, () => {
  if (authStore.isAuthed) {
    authStore.clearSession("unauthorized");
  }
});

app.mount("#app");
