<template>
  <div class="account">
    <div class="title">账户与 Prompt</div>

    <n-card v-if="!isAuthed" class="set-item">
      <n-empty description="登录后可管理账户与自定义评分 Prompt">
        <template #extra>
          <n-button type="primary" @click="openLogin">连接钱包登录</n-button>
        </template>
      </n-empty>
    </n-card>

    <template v-else>
      <n-h6 prefix="bar">账户</n-h6>
      <n-card class="set-item">
        <div class="account-row">
          <div class="name">
            <n-text class="text">{{ authStore.shortAddress || "已登录" }}</n-text>
            <n-text :depth="3" class="tip">{{ authStore.address }}</n-text>
          </div>
          <n-space align="center">
            <n-tag v-if="authStore.isDefaultAccount" type="warning" size="small" round>
              默认账户
            </n-tag>
            <n-button size="small" secondary @click="copyAddress">复制地址</n-button>
            <n-button size="small" quaternary @click="handleLogout">退出登录</n-button>
          </n-space>
        </div>

        <n-divider />

        <div class="meta-grid">
          <div class="meta-item">
            <n-text :depth="3" class="meta-label">用户 ID</n-text>
            <n-text>{{ profile.id ?? "-" }}</n-text>
          </div>
          <div class="meta-item">
            <n-text :depth="3" class="meta-label">注册时间</n-text>
            <n-text>{{ formatDate(profile.createdAt) }}</n-text>
          </div>
          <div class="meta-item">
            <n-text :depth="3" class="meta-label">Prompt 更新时间</n-text>
            <n-text>{{ formatDate(promptUpdatedAt) }}</n-text>
          </div>
        </div>
      </n-card>

      <n-h6 prefix="bar">我的评分 Prompt</n-h6>
      <n-card class="set-item">
        <n-space vertical :size="12">
          <n-alert type="info" :bordered="false">
            可以完全自定义打分规则与输出格式。保存后旧 AI 评分不再命中缓存，会在下次浏览时用新 Prompt 重新评分；你手动修正过的分数会保留。
          </n-alert>

          <n-input
            v-model:value="promptText"
            type="textarea"
            class="prompt-input"
            :autosize="{ minRows: 14, maxRows: 30 }"
            placeholder="在此编写你的评分 Prompt"
          />

          <div class="prompt-meta">
            <span>{{ promptText.length }} / {{ maxLength }} 字符</span>
            <span v-if="promptHash">指纹 {{ promptHash.slice(0, 8) }}</span>
            <span v-if="isDefault">当前为系统默认</span>
          </div>

          <n-space>
            <n-button
              type="primary"
              :loading="saving"
              :disabled="!dirty || promptText.trim().length < 50"
              @click="handleSave"
            >
              保存并生效
            </n-button>
            <n-button :loading="testing" :disabled="testing" @click="handleTest">
              试跑一次
            </n-button>
            <n-popconfirm @positive-click="handleReset">
              <template #trigger>
                <n-button quaternary :disabled="saving">恢复默认</n-button>
              </template>
              确认恢复为系统默认 Prompt？
            </n-popconfirm>
          </n-space>

          <n-alert
            v-if="testResult"
            :type="testResult.ok ? 'success' : 'warning'"
            :bordered="false"
          >
            <div v-if="testResult.ok">
              解析成功：score={{ testResult.parsed?.score }}，layer={{ testResult.parsed?.layer }}，reason={{
                testResult.parsed?.reason || "（空）"
              }}
            </div>
            <div v-else>解析失败：{{ testResult.hint || testResult.message }}</div>
            <pre class="raw-output">{{ testResult.raw }}</pre>
            <div class="test-meta">
              耗时 {{ testResult.latencyMs }}ms · {{ testResult.model }}
            </div>
          </n-alert>
        </n-space>
      </n-card>

      <n-h6 prefix="bar">手动调整过的新闻记录</n-h6>
      <n-card class="set-item">
        <UserScoreRecords />
      </n-card>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useAuthStore } from "@/store/auth";
import { AUTH_EVENTS, emitAuthEvent } from "@/utils/authEvents";
import UserScoreRecords from "@/components/Account/UserScoreRecords.vue";
import {
  getAccountProfile,
  getAccountPrompt,
  resetAccountPrompt,
  testAccountPrompt,
  updateAccountPrompt,
} from "@/api/auth";

const authStore = useAuthStore();
const { isAuthed } = storeToRefs(authStore);

const profile = ref({});
const promptText = ref("");
const savedPrompt = ref("");
const promptHash = ref("");
const isDefault = ref(true);
const maxLength = ref(20000);
const promptUpdatedAt = ref("");
const saving = ref(false);
const testing = ref(false);
const testResult = ref(null);

const dirty = computed(() => promptText.value !== savedPrompt.value);

const openLogin = () => emitAuthEvent(AUTH_EVENTS.OPEN_LOGIN);

const formatDate = (value) => {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
};

const applyPromptData = (data) => {
  promptText.value = data?.prompt || "";
  savedPrompt.value = data?.prompt || "";
  promptHash.value = data?.promptHash || "";
  isDefault.value = Boolean(data?.isDefault);
  promptUpdatedAt.value = data?.updatedAt || "";
  if (data?.maxLength) maxLength.value = data.maxLength;
};

const load = async () => {
  if (!isAuthed.value) return;
  try {
    const [promptRes, profileRes] = await Promise.all([
      getAccountPrompt(),
      getAccountProfile(),
    ]);
    applyPromptData(promptRes?.data);
    profile.value = profileRes?.data || {};
  } catch (error) {
    console.error("加载账户信息失败:", error);
  }
};

watch(isAuthed, (value) => {
  if (value) load();
});

onMounted(() => {
  if (isAuthed.value) load();
});

const handleSave = async () => {
  if (saving.value) return;
  saving.value = true;
  try {
    const res = await updateAccountPrompt(promptText.value);
    applyPromptData(res?.data);
    if (res?.data?.promptHash) {
      authStore.updateUser({ promptHash: res.data.promptHash });
    }
    const warnings = Array.isArray(res?.warnings) ? res.warnings : [];
    if (warnings.includes("prompt_suspicious_no_json_hint")) {
      window.$message?.warning("已保存，但未检测到明确的 JSON 输出格式，可能影响解析");
    } else {
      window.$message?.success("Prompt 已保存，将用于后续评分");
    }
  } catch (error) {
    window.$message?.error(error?.response?.data?.message || "保存 Prompt 失败");
  } finally {
    saving.value = false;
  }
};

const handleReset = async () => {
  saving.value = true;
  try {
    const res = await resetAccountPrompt();
    applyPromptData(res?.data);
    authStore.updateUser({ promptHash: res?.data?.promptHash || "" });
    window.$message?.success("已恢复系统默认 Prompt");
  } catch (error) {
    window.$message?.error("恢复默认失败");
  } finally {
    saving.value = false;
  }
};

const handleTest = async () => {
  if (testing.value) return;
  testing.value = true;
  testResult.value = null;
  try {
    const res = await testAccountPrompt({ prompt: promptText.value });
    testResult.value = res || { ok: false, hint: "未返回结果" };
  } catch (error) {
    const status = error?.response?.status;
    testResult.value = {
      ok: false,
      hint: status === 429 ? "试跑过于频繁，请稍后再试" : "试跑失败，请检查网络或稍后重试",
    };
  } finally {
    testing.value = false;
  }
};

const copyAddress = async () => {
  try {
    await navigator.clipboard.writeText(authStore.address);
    window.$message?.success("地址已复制");
  } catch {
    window.$message?.error("复制失败，请手动选择地址");
  }
};

const handleLogout = async () => {
  authStore.clearSession("logout");
  window.$message?.success("已退出登录");
};
</script>

<style lang="scss" scoped>
.account {
  .title {
    margin-top: 30px;
    margin-bottom: 20px;
    font-size: 40px;
    font-weight: bold;
  }

  .n-h {
    padding-left: 16px;
    font-size: 20px;
    margin-left: 4px;
  }

  .set-item {
    width: 100%;
    border-radius: 8px;
    margin-bottom: 12px;
  }

  .account-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;

    .name {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;

      .text {
        font-size: 20px;
        font-weight: 600;
      }

      .tip {
        font-size: 12px;
        word-break: break-all;
      }
    }
  }

  .meta-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;

    .meta-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .meta-label {
      font-size: 12px;
    }
  }

  .prompt-input :deep(textarea) {
    font-family: "SFMono-Regular", "JetBrains Mono", Menlo, Consolas, monospace;
    font-size: 13px;
    line-height: 1.6;
  }

  .prompt-meta {
    display: flex;
    gap: 16px;
    font-size: 12px;
    opacity: 0.65;
    flex-wrap: wrap;
  }

  .raw-output {
    margin: 8px 0 0;
    padding: 8px 10px;
    max-height: 160px;
    overflow: auto;
    border-radius: 6px;
    background: rgba(128, 128, 128, 0.12);
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-all;
  }

  .test-meta {
    margin-top: 6px;
    font-size: 12px;
    opacity: 0.65;
  }

  @media (max-width: 768px) {
    .title {
      font-size: 28px;
    }

    .account-row {
      flex-direction: column;
      align-items: flex-start;
    }

    .meta-grid {
      grid-template-columns: 1fr;
    }
  }
}
</style>
