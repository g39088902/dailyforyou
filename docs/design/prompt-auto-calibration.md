# 评分自动校准（Prompt 自更新）设计稿

> 状态：**设计稿，未实施**。
> 目标：用户拖动滑块修正分数之后，系统把这次修正变成可复用知识，自动改进该用户之后的评分，而不是让同一个错误反复发生。

---

## 0. 一句话结论

**不要改用户写的 Prompt，也不要边拖边改。**

系统把每次手动修正落成一条**反馈事件**，攒够一批后用 LLM 归纳成一段**独立的校准块**（`## 五、个人校准补充`），在评分时插到用户 Prompt 的「输出格式」段之前；评分缓存的键只认**用户手写正文**（`base prompt`），校准块换版本**不触发重评**。

三句话对应三个必须解决的问题：

| 问题 | 不这么做的后果 |
| :--- | :--- |
| 不改用户正文 | 3.8k 字的强定制 Prompt 被 LLM 重写一次，用户精心写的具体锚点（"外卖大法官 75 分"）就没了，且无法 diff |
| 不边拖边改 | 一次浏览拖十下 = 十次 prompt 变更 = 十次评分缓存全量失效 |
| 缓存键只认正文 | 每次自动校准都让 800+ 条历史评分失效，成本高两个数量级，且排序会抖动 |

---

## 1. 现状约束（读代码得出，不是假设）

改造前必须承认这四条，它们决定了方案形状。

### 1.1 `prompt_hash` 就是缓存的全部依据

`scorer.ts:scoreNewsItem` 的命中条件：

```ts
const usable =
  dbRecord &&
  ((dbRecord.ai_score >= 0 && dbRecord.prompt_hash === ctx.promptHash) ||
    Boolean(dbRecord.is_user_modified));
```

含义：

- Prompt 任何一个字节变化 → 该用户**所有**历史 AI 评分全部失效，下次浏览全量重评。
- 手动修正过的记录（`is_user_modified = 1`）**永久命中**，不受影响 —— 这点是好消息：改 Prompt 不会丢用户的修正。

按 27 个默认频道 × 每频道 30 条估算，一次全量重评 ≈ 800 次 LLM 调用。所以"实时改 Prompt"在这个架构下等于"实时清空缓存"，不可行。

### 1.2 Prompt 末尾是硬契约

`DEFAULT_SCORE_PROMPT` 共 3795 字符，章节固定：

```
## 一、用户画像与核心母题
## 二、五层漏斗与 0~100 分锚点
## 三、打分校准规则
## 四、输出格式     ← {"score": <0-100>, "layer": "...", "reason": "..."}
```

自动生成的内容若追加在「四、输出格式」之后，会稀释格式约束；`parseScoreResponse` 虽有纯数字降级，但会标 `degraded` 且丢掉 `reason`，前端展示直接劣化。

### 1.3 手改信号又密又糙

- 前端 `useStreamScoring.commitManualScore` 只传 `userScore` + `userLayer`，**从不传 `userReason`**（字段存在，UI 没做）。
- 松手即提交，一次浏览可能连改十几条。
- 大量修正是 ±3~5 的小幅抖动，属于噪音；直接喂给 LLM 会归纳出"用户喜欢 55 分左右的内容"这种废话规则。
- `saveUserManualScore` 也**不落 `desc`**：`user_news_states` 只有 `title` / `source` / `url`，样本信息量偏薄。

### 1.4 单进程、无队列

`backend/src/index.ts` 只做 `serve`，没有后台任务框架；`rateLimit.ts` 是进程内固定窗口。所以调度只能是**进程内定时器 + CLI 手动触发**，靠数据库做幂等，不能假设有 MQ。

---

## 2. 目标与非目标

**目标**

1. 拖滑块这一动作零额外延迟、零额外 LLM 调用（同步链路只多一次 INSERT）。
2. 系统能从一批修正里归纳出**可判定、可解释、可回滚**的规则。
3. 自动校准**不触发**历史评分重算。
4. 用户随时能看到"系统学了什么"，并一键关掉 / 回滚。

**非目标**

- 不做全站共享的公共 Prompt（多用户各自的偏好互相污染）。
- 不做在线学习 / 微调模型。
- 不自动改动用户手写正文（`user_profiles.score_prompt` 只由 `PUT /account/prompt` 写）。
- P0 不做 few-shot 动态注入（见 §8 的取舍）。

---

## 3. 总体结构

```
拖滑块
  │
  ├─(同步，O(1))─▶ user_news_states       现有逻辑不变
  │                 user_score_feedback    新增：事件流水（含过滤）
  │
  └─(异步，15min 定时 / CLI)
        │
        ├─ 取 pending 样本（≥8 条 且 距上次 ≥72h）
        ├─ LLM 归纳 → { rules[], note }     结构化，强校验
        ├─ 评估闸门（holdout 新旧对比，可选）
        └─ 写 user_prompt_calibrations
              │
              ├─ mode=review → 账户页待确认，用户点"应用"
              └─ mode=auto   → 直接 active
                    │
                    ▼
        getPromptContext() 返回 effectivePrompt = base + 校准块
        promptHash 仍 = hash(base)   ← 缓存不受影响
```

---

## 4. 数据模型

新增两张表 + `user_profiles` 五个字段 + `user_news_states` 一个观测列。全部走 `user_migrations`（新增 `u004_score_feedback`、`u005_prompt_calibration`），禁止手写 ALTER。

### 4.1 `user_score_feedback`（反馈事件流水）

独立于 `user_news_states` 的理由：后者是"当前状态"，会被再次修改/重置覆盖；反馈需要**事件语义**（何时、改前改后、被哪次校准消费），且不能污染评分热表的索引。

```sql
CREATE TABLE IF NOT EXISTS user_score_feedback (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL,
  news_hash        TEXT NOT NULL,
  source           TEXT NOT NULL DEFAULT '',
  title            TEXT NOT NULL DEFAULT '',
  desc             TEXT NOT NULL DEFAULT '',   -- 新增采集，≤500 字（来自请求体）
  ai_score         INTEGER NOT NULL,
  ai_layer         TEXT NOT NULL DEFAULT '',
  ai_reason        TEXT NOT NULL DEFAULT '',
  user_score       INTEGER NOT NULL,
  user_layer       TEXT NOT NULL DEFAULT '',
  delta            INTEGER NOT NULL,           -- user_score - ai_score
  user_reason      TEXT,                       -- 用户填的原因/标签，可空
  base_prompt_hash TEXT NOT NULL DEFAULT '',   -- 修正发生时的手写正文指纹（归因用）
  calib_version    INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'pending',  -- pending | consumed | ignored
  calibration_id   INTEGER,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- 同一用户同一新闻只保留最后一次修正（再次修改则覆盖并回到 pending）
CREATE UNIQUE INDEX IF NOT EXISTS uq_usf_user_news
  ON user_score_feedback(user_id, news_hash);
CREATE INDEX IF NOT EXISTS idx_usf_pending
  ON user_score_feedback(user_id, status, created_at DESC);
```

### 4.2 `user_prompt_calibrations`（校准版本）

```sql
CREATE TABLE IF NOT EXISTS user_prompt_calibrations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL,
  version          INTEGER NOT NULL,
  note             TEXT NOT NULL,                    -- 渲染好的 markdown 块（含标题）
  rules_json       TEXT NOT NULL DEFAULT '[]',       -- 结构化规则，前端做 diff 展示
  base_prompt_hash TEXT NOT NULL,                    -- 生成时的正文指纹；不匹配即作废
  sample_ids       TEXT NOT NULL DEFAULT '[]',
  sample_count     INTEGER NOT NULL DEFAULT 0,
  eval_json        TEXT NOT NULL DEFAULT '{}',       -- {baseline:{...}, candidate:{...}}
  status           TEXT NOT NULL DEFAULT 'candidate',
                     -- candidate | active | rejected | superseded | rolled_back
  mode             TEXT NOT NULL DEFAULT 'review',   -- 生成时的模式快照
  model            TEXT NOT NULL DEFAULT '',
  tokens           INTEGER NOT NULL DEFAULT 0,
  error            TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL,
  activated_at     TEXT,
  UNIQUE(user_id, version)
);
CREATE INDEX IF NOT EXISTS idx_upc_user_status
  ON user_prompt_calibrations(user_id, status, version DESC);
```

### 4.3 `user_profiles` 扩展

```sql
ALTER TABLE user_profiles ADD COLUMN calibration_enabled       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_profiles ADD COLUMN calibration_mode          TEXT    NOT NULL DEFAULT 'review';
ALTER TABLE user_profiles ADD COLUMN active_calibration_id     INTEGER;
ALTER TABLE user_profiles ADD COLUMN calibration_min_samples   INTEGER NOT NULL DEFAULT 8;
ALTER TABLE user_profiles ADD COLUMN calibration_cooldown_hours INTEGER NOT NULL DEFAULT 72;
```

`calibration_enabled` 默认 **0**：学习是显式开启的能力，不做"AI 悄悄改了我的 Prompt"。用户开了之后默认 `review`（生成候选，人点应用），可切 `auto`。

### 4.4 `user_news_states` 观测列

```sql
ALTER TABLE user_news_states ADD COLUMN calib_version INTEGER NOT NULL DEFAULT 0;
```

只用于事后分析"这条评分是哪代校准打的"，不参与任何命中判断。

---

## 5. 反馈采集

### 5.1 落点

唯一落点：`scorer.ts:updateManualScoreItem`，在 `saveUserManualScore` 成功之后。这样 `POST/PUT/PATCH/DELETE /score/manual`、`/score/feedback`、批量 `items[]` 全部自动覆盖，不需要前端配合。

### 5.2 过滤规则（先降噪，再学习）

| 情况 | 处理 |
| :--- | :--- |
| `\|delta\| < 5` | **不记**。±1~4 是手感抖动，学它只会过拟合 |
| `delta == 0` | 不记 |
| `reset = true`（撤回修正） | `DELETE` 该用户该新闻的 pending 反馈；已 consumed 的保留（历史不可改） |
| 记录新建（此前无 AI 评分，`ai_score` 由 `user_score` 回填） | 不记（`ai_score == user_score`，天然 delta=0） |
| 同一新闻 24h 内多次调整 | `ON CONFLICT(user_id, news_hash) DO UPDATE`，只留最后一次，`status` 重置为 `pending` |

写入时同步冗余 `desc`（`extractNewsMetadata(payload).desc`，截 500 字）—— `user_news_states` 不存正文，这里必须自己存，否则归纳时只有标题。

### 5.3 响应回带进度

`updateManualScoreItem` 的返回值里追加一个轻量字段，避免前端多发一次请求：

```ts
calibration?: { enabled: boolean; pending: number; threshold: number };
```

前端 toast 从 `已修正评分为 62 分 (L4)` 变成 `已修正 62 分 · 校准样本 3/8`。

---

## 6. 归纳

### 6.1 触发条件（全部满足才跑）

```
enabled = true
AND pending 样本数 ≥ calibration_min_samples（默认 8）
AND now - last_activated_or_generated_at ≥ cooldown（默认 72h）
AND 当日次数 < 1 且 近 30 天次数 < 8
```

落在 `calibrationRunner.ts`：

- 进程内 `setInterval(15 * 60 * 1000)`，`.unref()`，`index.ts` 启动后挂载，`shutdown` 时清理。
- 同一函数也暴露为 CLI：`pnpm --filter backend calibrate --user 1 --force`，供 cron 或调试。
- 幂等：进程内 `Set<userId>` 互斥 + 库内检查最近 10 分钟是否有 `status='candidate'` 的同源记录；多实例部署时用 `UPDATE user_profiles SET calibration_locked_at=? WHERE ... AND (calibration_locked_at IS NULL OR calibration_locked_at < ?)` 做 CAS（P0 单实例可先不做）。

### 6.2 归纳 Prompt（强约束）

system 里只做一件事：**把样本压成规则，不许改契约**。

```
你是评分规则归纳器。输入是某用户对 AI 评分的 N 条手动修正。
任务：归纳出能解释这些修正的**可判定规则**，供同一套评分 Prompt 复用。

硬约束：
1. 只输出 JSON：{"rules":[...],"note":"..."}
2. rules 每条 ≤ 60 字，最多 8 条；note ≤ 1200 字符
3. 规则必须带可判定的条件（领域/来源/标题特征/内容类型），
   禁止"用户喜欢好内容""提高准确性"这类空话
4. 禁止修改输出格式、分数区间定义、用户画像事实
5. 与已有校准块冲突时，用 op=adjust/remove 指向旧条目编号，不要重复新增
6. 每条规则必须能追溯到至少 1 条样本（写进 why）

输入样本格式：
| # | 来源 | 标题 | AI 分/理由 | 用户改分 | delta | 用户说明 |
```

输出示例：

```json
{
  "rules": [
    { "op": "add", "scope": "L5", "condition": "论坛品牌情绪站队类（华为/小米芯片互踩、无技术细节）", "score": "0~15", "why": "3 条样本平均 -42（#1,#4,#9）" },
    { "op": "adjust", "target": "r2", "score": "30~38", "why": "2 条样本把原 50 分压到 32（#5,#7）" }
  ],
  "note": "## 五、个人校准补充（自动维护 · v3 · 归纳自 12 条修正）\n> 本节只补充评分偏好，不改变上文的输出格式要求。\n\n1. [L5] 论坛品牌情绪站队类（华为/小米芯片互踩、无技术细节）→ 0~15 分。依据：3 条修正，平均 -42。\n2. ..."
}
```

### 6.3 渲染格式

```markdown
## 五、个人校准补充（自动维护 · v3 · 归纳自 12 条修正）
> 本节只补充评分偏好，不改变上文的输出格式要求。

1. [L5] 论坛品牌情绪站队类（华为/小米芯片互踩、无技术细节）→ 0~15 分。依据：3 条修正，平均 -42。
2. [L4] 纯融资/估值传闻、无产品落地的 AI 创业新闻 → 40~48 分。依据：2 条修正，平均 -15。
```

三点设计意图：

- 标题带**版本号与样本数**，让用户一眼知道这节的来源和"新鲜度"。
- 每条带**依据**（样本数 + 平均 delta），用户能判断是真规律还是过拟合。
- 第二行那句声明是**兜底契约保护**：即使注入位置出错，也不会让模型以为格式要求被覆盖。

### 6.4 硬校验（不通过直接 `rejected`，不写 active）

| 校验 | 处理 |
| :--- | :--- |
| `note` 长度 > 1200 字符 / 规则 > 8 条 | reject |
| 命中黑名单正则：`输出格式`、`JSON`、`"score"`、`layer`、`返回格式` | reject |
| `rules` 中出现空话（长度 < 8 或无可判定名词） | reject |
| note 未以 `## 五、` 开头 | reject |
| 自检：用新 effective prompt 对 1 条样本试跑，`parseScoreResponse` 返回 null | reject（这条最贵但最值，防解析全线崩） |

校验函数：`calibration.ts:validateCalibrationNote(basePrompt, note)`。
长度还要叠加检查 `base.length + note.length <= SCORE_PROMPT_MAX_LENGTH`。

---

## 7. 生效：两级 hash（本方案的核心）

### 7.1 语义拆分

| 概念 | 存储 | 用途 |
| :--- | :--- | :--- |
| `base` | `user_profiles.score_prompt` | 用户手写正文，只有 `PUT /account/prompt` 能改 |
| `note` | `user_prompt_calibrations.note`（active 那条） | 自动生成，独立版本、独立回滚 |
| `effective` | 运行时拼接，不落库 | 实际发给 LLM 的 system |
| `promptHash` | `hash(base)` | **缓存键** |

### 7.2 拼接规则

```ts
// calibration.ts
const ANCHOR = /^##\s*四、输出格式/m;

export const injectCalibration = (base: string, note: string): string => {
  const m = ANCHOR.exec(base);
  if (m) return `${base.slice(0, m.index)}${note}\n\n${base.slice(m.index)}`;
  // 无锚点（用户自定义 Prompt）：追加末尾，note 自带格式声明兜底
  return `${base.trimEnd()}\n\n${note}`;
};
```

优先插在「四、输出格式」之前；用户自定义 Prompt 没有该章节时退化为末尾追加，靠 note 第 2 行的声明保护契约。

### 7.3 `promptDb.getPromptContext` 改造（改动面极小）

```ts
export interface PromptContext {
  prompt: string;            // base，供账户页编辑
  effectivePrompt: string;   // 实际请求用
  promptHash: string;        // hash(base)
  isDefault: boolean;
  calibration: { id: number; version: number; note: string } | null;
}
```

```ts
const base = String(row.score_prompt || "") || DEFAULT_SCORE_PROMPT;
const active = await getActiveCalibration(userId);           // 命中 60s 缓存
const note = active && active.base_prompt_hash === hashPrompt(base) ? active.note : "";
const effectivePrompt = note ? injectCalibration(base, note) : base;
```

关键一行在 `registry.ts:buildScoreContext`：

```ts
return {
  userId,
  promptText: prompt.effectivePrompt,   // 请求用新块
  promptHash: prompt.promptHash,        // 缓存仍认 base
};
```

`scorer.ts` **一行都不用改**：它拿 `ctx.promptText` 发请求、拿 `ctx.promptHash` 判缓存，语义自洽。

### 7.4 缓存不失效的代价（必须写在文档里）

- 自动校准升级后，**旧评分继续沿用旧校准**，只有未评分过的新闻用新规则。排序会出现"代际混用"。
- 这是刻意的：用一点点一致性换掉 800 次/次的重评成本。
- 想强制刷新时用现有 `?force=true`，或加一个"用新校准重评当前频道"的按钮（P2）。
- **用户手改正文时**（`PUT /account/prompt`）`base` 变化 → 全量重评，与现有 Account.vue 的提示文案「保存后旧 AI 评分不再命中缓存」完全一致，语义不变。

### 7.5 校准块作废规则

| 事件 | 处理 |
| :--- | :--- |
| `PUT /account/prompt` 后 `hash(base) != active.base_prompt_hash` | active → `superseded`，样本回到 `pending`（重新归纳） |
| 用户回滚 | active → `rolled_back`，`active_calibration_id = NULL` |
| 新版本激活 | 旧 active → `superseded` |

任何状态变更后必须 `invalidatePromptCache(userId)`（`promptDb` 已有该函数）。

---

## 8. 为什么不做 few-shot 注入

先说结论：**P2 再考虑，不作为主路径**。

| 方案 | 优势 | 代价 |
| :--- | :--- | :--- |
| 规则块（本方案） | token 增量 ~300；可解释、可 diff、可回滚；前缀稳定，DeepSeek 上下文缓存命中率高 | 规则表达力有限，跨层迁移靠文字描述 |
| 动态 few-shot | LLM 对示例的模仿通常强于对规则的理解 | 每次多 600~1200 输入 token；样本集随新闻变化 → 前缀不稳定 → 缓存命中率下降；无法解释"为什么这条被打低" |

真要做 few-shot，正确姿势是**按校准版本冻结一组样本**（如 6 条），整体拼在校准块后面，随版本更替整批换掉，以保住前缀缓存。这件事的复杂度接近再造一套样本选择器，收益不确定，所以放 P2。

---

## 9. 产品模式与前端

### 9.1 两种模式

| 模式 | 行为 | 适用 |
| :--- | :--- | :--- |
| `review`（默认） | 生成 `candidate`，账户页提示"发现 4 条新偏好"，用户点应用才 active | 珍惜 Prompt、要看清楚系统学了什么 |
| `auto` | 校验 + 评估通过直接 active | 相信闸门、想彻底放手 |

即使是 `auto`，也要保留**评估闸门**（§10）与**一键回滚**。

### 9.2 账户页新增卡片「自动校准」

放在现有「我的评分 Prompt」卡片下方：

```
[开关] 根据我的手改自动校准
模式：○ 先给我看（review）  ● 直接生效（auto）
待处理样本 12 条 · 上次校准 3 天前 · 当前 v3
[立即校准]  [回滚到 v2]

──── 本次候选 v4（12 条样本）────
+ [L5] 论坛品牌情绪站队类 → 0~15（平均 -42，3 条）
~ [L4] 纯融资传闻 → 40~48（原 50~55，2 条）
− 删除 v3 第 3 条（被 2 条反例推翻）
评估：方向命中 0.72 → 0.86，MAE 18.4 → 12.1
[应用]  [忽略]
```

Prompt 编辑框仍显示 `base`（用户手写），下方加一个折叠只读区展示当前生效的校准块，避免"我看到的和我实际用的是两回事"。

### 9.3 滑块加"为什么"（P1，强烈建议）

`user_reason` 字段早就存在，前端一直没传。在滑块松手后的气泡里放 6 个预置标签 + 可选文本框：

`太旧` `来源噪音` `标题党` `领域不关心` `应为 L1` `内容太水`

一次点击的成本，换来归纳质量的数量级提升 —— 有标签时规则能直接写出条件（"标题党"），没有标签只能靠标题猜。标签随 `POST /score/manual` 的 `userReason` 一起提交，`updateManualScoreItem` 已经支持。

### 9.4 API（全部挂在 `accountRouter`，`requireAuth`）

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| GET | `/account/calibration` | 开关、模式、待处理数、阈值、active/candidate 列表 |
| PUT | `/account/calibration/settings` | `{enabled, mode, minSamples, cooldownHours}` |
| POST | `/account/calibration/run` | 立即归纳（`consumeRateLimit('calib:run:'+uid, 1, 5min)`） |
| GET | `/account/calibration/:id` | 详情：rules、note、eval、样本 |
| POST | `/account/calibration/:id/apply` | review 模式采纳 |
| POST | `/account/calibration/:id/reject` | 丢弃，样本标记 `ignored` |
| POST | `/account/calibration/rollback` | 回上一版 / 关闭 |

`error` 字段要能回传"为什么被拒"，前端直接展示，别只写日志。

---

## 10. 评估闸门（P1，可开关）

不做评估的自动校准，本质是"在用户身上做实验且不测量"。所以自动应用前跑一次 holdout：

1. 从 pending 样本里随机留出 30%（至少 4 条，最多 8 条），**不进入归纳**。
2. 用 `oldEffective` 与 `newEffective` 分别对 holdout 打分（并发 5）。
3. 指标：

```ts
// 方向命中：新分相对旧 AI 分，是否朝着用户调整的方向动
dirHit = mean(sign(pred - ai_score) === sign(user_score - ai_score))
// 平均绝对误差：直接看离用户想要的分数有多远
mae = mean(|pred - user_score|)
```

4. 通过条件：

```
dirHit_new >= 0.6 && (dirHit_new >= dirHit_old + 0.15 || mae_new <= mae_old * 0.85)
```

5. 不通过 → `status='rejected'`，`error='eval_regressed'`，holdout 样本保留 pending（下批再试），其余标 `ignored`（防止死循环反复烧钱）。

成本：8 条 × 2 次 = 16 次调用，DeepSeek Flash 下单次可忽略，但仍在 `calibrationRunner` 里用并发 5 控住。

`evaluation` 默认开启；配置项 `CALIBRATION_EVAL=true`。

---

## 11. 代码改动清单

| 文件 | 改动 |
| :--- | :--- |
| `backend/src/utils/migrations.ts` | 新增 `u004_score_feedback`、`u005_prompt_calibration`（PRAGMA 检查列存在，照 `u003` 写法） |
| `backend/src/utils/feedbackDb.ts` | **新建**：`saveFeedback` / `deletePendingFeedback` / `listPendingFeedback` / `countPendingFeedback` / `markConsumed` |
| `backend/src/utils/calibrationDb.ts` | **新建**：校准 CRUD、`getActiveCalibration`（60s 缓存）、`activateCalibration`（事务内切指针）、`supersedeByBaseHash` |
| `backend/src/utils/calibration.ts` | **新建**：`injectCalibration`、`buildCalibrationMessages`、`validateCalibrationNote`、`renderNote`、`hashBase` |
| `backend/src/utils/calibrationRunner.ts` | **新建**：`runCalibration(userId, {force})`、`startCalibrationScheduler()`、评估逻辑 |
| `backend/src/utils/scorer.ts` | `updateManualScoreItem` 末尾调 `maybeRecordFeedback()`（唯一侵入点） |
| `backend/src/utils/promptDb.ts` | `PromptContext` 加 `effectivePrompt` / `calibration`；`getPromptContext` 拼校准块；`updateUserPrompt` 触发 supersede |
| `backend/src/types.d.ts` | `PromptContext` 同步；新增 `CalibrationRule` / `CalibrationNote` |
| `backend/src/registry.ts` | `buildScoreContext` 改用 `effectivePrompt`；manual 接口回带 `calibration` 进度 |
| `backend/src/api/account.ts` | 新增 §9.4 七个路由 |
| `backend/src/config.ts` | `CALIBRATION_ENABLED_DEFAULT`、`CALIBRATION_EVAL`、`CALIBRATION_MODEL`（可单独指定归纳用模型） |
| `backend/src/index.ts` | 启动 `startCalibrationScheduler()`，shutdown 时清理 |
| `frontend/src/api/auth.js` | 5 个校准接口封装 |
| `frontend/src/components/Account/PromptCalibration.vue` | **新建**：状态卡 + 规则 diff + 评估指标 + 操作按钮 |
| `frontend/src/views/Account.vue` | 挂载新卡片；Prompt 编辑框下方加只读的"当前生效校准块" |
| `frontend/src/components/Stream/composables/useStreamScoring.js` | toast 文案带样本进度；`commitManualScore` 带上 `userReason`（P1） |
| `frontend/src/components/Stream/StreamScoreBadge.vue` | 松手后弹原因标签（P1） |

改造量：后端 ~700 行（含迁移与调度），前端 ~300 行。**核心侵入点只有 `scorer.ts` 一处 hook 与 `promptDb.ts` 一处拼接**，其余是新增文件。

---

## 12. 分期

| 阶段 | 内容 | 产出 | 风险 |
| :--- | :--- | :--- | :--- |
| **P0**（1 天） | 建表 + 采集 hook + 过滤 + 账户页只读统计（"已积累 12 条修正，可校准"） | 数据开始攒，行为零变化 | 无 |
| **P1**（2~3 天） | 归纳 + 校验 + `injectCalibration` + review 模式 + 手动"立即校准" | 用户点一下就能看到规则并应用 | 中：Prompt 变长影响解析 → 靠 §6.4 自检兜底 |
| **P2**（2 天） | 定时调度 + 评估闸门 + auto 模式 + 回滚/版本列表 | 真正"自动" | 中：成本与漂移 → 配额 + 闸门 |
| **P3**（可选） | 原因标签、few-shot 冻结样本、按校准重评当前频道 | 质量上限 | 低 |

不建议跳过 P0 直接做 P2：没有干净的反馈流水，后面所有归纳都是在脏数据上做实验。

---

## 13. 风险与对策

| 风险 | 对策 |
| :--- | :--- |
| 归纳出与手写正文矛盾的规则 | 校准块独立成节、只做"补充"；note 开头声明不改契约；review 模式人审 |
| 学到噪音（±3 抖动） | `|delta| >= 5` 才采集；`|delta| < 10` 在归纳输入里标 `weak`，不计入 `why` 的证据数 |
| 过度泛化（"含'重磅'就下调"） | 规则必须带 `condition` + 可追溯 `why`；评估闸门用 holdout 抓过拟合 |
| Prompt 变长 → token 成本与注意力稀释 | note ≤ 1200 字符、规则 ≤ 8 条；超限拒绝而不是截断 |
| 校准历史无限增长 | 只保留最近 20 版，更早的物理删除（`status='archived'` 后清理） |
| 用户改了正文，旧校准语义漂移 | `base_prompt_hash` 不匹配即 `superseded`，样本重回 pending |
| 多实例并发跑同一用户 | 进程内锁 + DB CAS（`calibration_locked_at`）；P0 单实例可先只做进程内锁 |
| 回滚后排序没变化 | 预期行为：base 未变 → 缓存仍命中。文档写明，避免被当 bug |

---

## 14. 验收

**单测**（`backend/src/utils/__tests__/calibration.test.ts`，或沿用现有 scripts 风格）

1. `injectCalibration` 在「## 四、输出格式」前插入；无锚点时追加末尾；`base` 不含锚点且 note 超长时抛错。
2. `hash(base)` 在插入 note 前后**不变**（缓存不失效的回归断言）。
3. `validateCalibrationNote` 对黑名单（`输出格式`、`"score"`）、超长、空话规则的拒绝。
4. delta 过滤：`|delta|=4` 不入库、`|delta|=5` 入库；重置删除 pending。
5. `supersedeByBaseHash`：改正文后 active 变 `superseded`。

**e2e**（`backend/scripts/calibration-e2e.mjs`，照 `login-e2e.mjs` 的临时用户 + 自清理）

1. 造 10 条 `|delta|>=10` 的修正 → `POST /account/calibration/run` → 断言返回 `candidate` 且 `rules.length > 0`。
2. `GET /account/prompt` 断言 `promptHash` 与应用前**一致**（核心断言）。
3. 用同一批新闻再查 `/score/cache`，断言仍然 `hit`（证明没有触发重评）。
4. `POST /account/calibration/:id/apply` → `GET /account/prompt` 返回 `calibration.version` 递增、prompt 正文未变。
5. `POST /account/calibration/rollback` → active 为空、样本回到 pending。

**上线观测**

- 日志关键字：`🎚️ [Calibration] generated` / `applied` / `rejected`，附 `version / samples / tokens / dirHit`。
- 关键指标：`candidate → applied` 比例（review 模式下低于 30% 说明归纳质量差）、`rejected` 原因分布、每用户每月调用次数。

---

## 15. 与现有约定的关系

- 表结构唯一副本在 `docs/contracts/data-model.md`：本方案落地时，两张新表要同步写进去，**不要只留在本文**。
- 迁移账本：`user_migrations`，新增 `u004` / `u005`，禁止手写 ALTER（`migrations.ts` 已封装 `runBatch`）。
- 评分档位策略不变：归纳/评估复用 `config.DEEPSEEK_*`，但归纳是"文本生成"而非"打分"，建议单独配置 `CALIBRATION_MODEL`（可用更便宜的档），与评分档位解耦。
- `prompt_hash` 语义从"effective 指纹"改为"base 指纹"：因为当前没有校准块，历史数据里两者相等，**无需回填**，天然兼容。这一条是选择两级 hash 而非新增列的主要原因。
