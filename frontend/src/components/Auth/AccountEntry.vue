<template>
  <div class="account-entry">
    <n-button
      v-if="!isAuthed"
      secondary
      strong
      round
      size="small"
      @click="openLogin"
    >
      登录
    </n-button>

    <n-dropdown v-else :options="menuOptions" trigger="click" @select="handleSelect">
      <n-button secondary strong round size="small">
        {{ authStore.shortAddress || "我的账户" }}
      </n-button>
    </n-dropdown>

    <LoginModal ref="loginModalRef" />
  </div>
</template>

<script setup>
import { computed, h, ref } from "vue";
import { useRouter } from "vue-router";
import { NText } from "naive-ui";
import { storeToRefs } from "pinia";
import { useAuthStore } from "@/store/auth";
import { logoutAuth } from "@/api/auth";
import LoginModal from "@/components/Auth/LoginModal.vue";

const router = useRouter();
const authStore = useAuthStore();
const { isAuthed } = storeToRefs(authStore);
const loginModalRef = ref(null);

const openLogin = () => {
  loginModalRef.value?.open?.();
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
