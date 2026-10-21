<template>
  <div class="account-entry">
    <n-button
      v-if="!isAuthed"
      secondary
      strong
      round
      :size="size"
      @click="openLogin"
    >
      <template #icon>
        <n-icon :component="WalletOne" />
      </template>
      登录
    </n-button>

    <n-dropdown v-else :options="menuOptions" trigger="click" @select="handleSelect">
      <n-button secondary strong round :size="size">
        <template #icon>
          <n-icon :component="WalletOne" />
        </template>
        {{ authStore.shortAddress || "我的账户" }}
      </n-button>
    </n-dropdown>
  </div>
</template>

<script setup>
import { computed, h } from "vue";
import { useRouter } from "vue-router";
import { NText } from "naive-ui";
import { storeToRefs } from "pinia";
import { WalletOne } from "@icon-park/vue-next";
import { useAuthStore } from "@/store/auth";
import { logoutAuth } from "@/api/auth";
import { AUTH_EVENTS, emitAuthEvent } from "@/utils/authEvents";

defineProps({
  size: {
    type: String,
    default: undefined,
  },
});

const router = useRouter();
const authStore = useAuthStore();
const { isAuthed } = storeToRefs(authStore);

const openLogin = () => {
  emitAuthEvent(AUTH_EVENTS.OPEN_LOGIN);
};

const menuOptions = computed(() => [
  {
    key: "identity",
    type: "render",
    render: () =>
      h(
        NText,
        { depth: 3, style: "font-size: 12px; padding: 0 4px;" },
        { default: () => authStore.address || "" }
      ),
  },
  { key: "divider", type: "divider" },
  { label: "账户与 Prompt", key: "account" },
  { label: "退出登录", key: "logout" },
]);

const handleSelect = async (key) => {
  if (key === "account") {
    router.push("/account");
    return;
  }
  if (key === "logout") {
    try {
      await logoutAuth();
    } catch {
      // 无状态令牌，退出失败也照常清理本地
    }
    authStore.clearSession("logout");
    window.$message?.success("已退出登录");
  }
};
</script>

<style lang="scss" scoped>
.account-entry {
  display: inline-flex;
  align-items: center;
}
</style>
