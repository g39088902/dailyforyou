<template>
  <n-modal
    v-model:show="visible"
    preset="card"
    title="登录 DailyForYou"
    :bordered="false"
    :mask-closable="!loading"
    :closable="!loading"
    style="max-width: 460px"
  >
    <n-space vertical :size="16">
      <n-text :depth="3">
        登录后即可启用 AI 评分、跨端已读同步与自定义评分 Prompt。签名不会发起链上交易，也不消耗 Gas。
      </n-text>

      <n-card
        v-for="provider in providers"
        :key="provider.id"
        size="small"
        :class="['provider-card', { disabled: !provider.enabled }]"
      >
        <div class="provider-row">
          <div class="provider-info">
            <n-text class="provider-label">{{ provider.label }}</n-text>
            <n-text :depth="3" class="provider-hint">{{ provider.hint }}</n-text>
          </div>

          <n-button
            v-if="provider.id === 'ethereum' && provider.enabled"
            type="primary"
            :loading="loading"
            :disabled="loading"
            @click="handleLogin"
          >
            {{ actionText }}
          </n-button>
          <n-tag v-else type="default" size="small" round>即将支持</n-tag>
        </div>
      </n-card>

      <n-alert v-if="errorText" type="error" :bordered="false" closable @close="errorText = ''">
        {{ errorText }}
      </n-alert>

      <n-text :depth="3" class="footnote">
        当前仅支持 MetaMask 及兼容 EIP-1193 的浏览器钱包。微信扫码与手机号登录已预留接口。
      </n-text>
    </n-space>
  </n-modal>
</template>

<script setup>
import { computed, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { useAuthStore } from "@/store/auth";
import { getAuthNonce, getAuthProviders, verifyWalletSignature } from "@/api/auth";
import { connectWallet, describeWalletError, personalSign } from "@/utils/wallet";
import { AUTH_EVENTS, onAuthEvent } from "@/utils/authEvents";

const visible = ref(false);
const loading = ref(false);
const errorText = ref("");
const step = ref("idle");
const providers = ref([
  { id: "ethereum", label: "MetaMask 钱包", enabled: true, hint: "使用钱包签名登录" },
]);

const authStore = useAuthStore();
const { isAuthed } = storeToRefs(authStore);

const actionText = computed(() => {
  if (step.value === "connecting") return "连接钱包中";
  if (step.value === "signing") return "等待签名";
  if (step.value === "verifying") return "验证签名";
  return "连接钱包登录";
});

const loadProviders = async () => {
  try {
    const res = await getAuthProviders();
    if (Array.isArray(res?.data) && res.data.length > 0) {
      providers.value = res.data;
    }
  } catch (error) {
    console.warn("加载登录渠道失败:", error);
  }
};

const open = () => {
  if (isAuthed.value) return;
  errorText.value = "";
  visible.value = true;
  loadProviders();
};

const handleLogin = async () => {
  if (loading.value) return;
  errorText.value = "";
  loading.value = true;
  try {
    step.value = "connecting";
    const { address, chainId } = await connectWallet();

    step.value = "signing";
    const nonceRes = await getAuthNonce(address, chainId);
    const message = nonceRes?.message || "";
    if (!message) throw new Error("未获取到登录挑战");

    const signature = await personalSign(message, address);

    step.value = "verifying";
    const verified = await verifyWalletSignature({ message, signature });
    if (!verified?.token) throw new Error(verified?.message || "登录失败：未返回令牌");

    authStore.setSession({ token: verified.token, user: verified.user });
    window.$message?.success("登录成功");
    visible.value = false;
  } catch (error) {
    errorText.value = describeWalletError(error);
  } finally {
    loading.value = false;
    step.value = "idle";
  }
};

onMounted(() => {
  onAuthEvent(AUTH_EVENTS.OPEN_LOGIN, open);
});

defineExpose({ open });
</script>

<style lang="scss" scoped>
.provider-card {
  border-radius: 10px;

  &.disabled {
    opacity: 0.7;
  }

  .provider-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }

  .provider-info {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .provider-label {
    font-size: 15px;
    font-weight: 600;
  }

  .provider-hint {
    font-size: 12px;
  }
}

.footnote {
  font-size: 12px;
  line-height: 1.6;
}
</style>
