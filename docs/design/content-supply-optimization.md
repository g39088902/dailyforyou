# 内容供给质量优化方案

> 上游依据：`docs/SOURCE_STABILITY.md`（2026-10-29，40 个适配器 / 9,940 行 / 136 次抓取）
> 范围：只处理报告中**可归因到平台层与适配器层**的问题。不做信源扩张、不做前端改版、不替换技术栈。
> 性质：可排期的设计稿——每个工作项都写明落点文件、验收口径与回滚方式。

---

## 0. 结论先说

报告列的 6 个系统性风险，收敛成 3 条主线、9 个工作项：

| 主线 | 要解决的问题 | 工作项 | 可量化收益 |
| :--- | :--- | :--- | :--- |
| **A 数据正确性** | 同一条新闻重复入库、重复展示；时间字段脏 | A1 身份指纹、A2 翻译定稿+前置过滤、A3 时间闸门 | 重复展示 **-66%**，库容 **-32%**，翻译调用 **-70%** |
| **B 失效可见性** | 抓到了但悄悄变空，没人知道 | B1 空转计数、B2 健康语义+前端提示、B3 整轮可观测、B4 风控可读 | 静默失效检出 **0/3 → 3/3** |
| **C 供给韧性** | 6s 超时零重试、7 个频道挤在一个中转 | C1 超时分级+一次重试、C2 中转兜底 | 境外失败率 **5.9% → <1%** |

三条优先级判断：

1. **A1 是唯一"改完立刻见效"的动作**，且风险比报告估计的低（原因见 §1.2）。先做它。
2. **B1 必须先于 A2 上线**。A2 会让"这一轮没有新条目"变成常态，B1 负责把它和"真的挂了"区分开。顺序反了会出现"全站频道同时 stale"的假故障。
3. **C2 只做"接受单点 + 4 小时内可发现"**。给路透找第二个数据源是伪需求——真正的兜底是让用户知道这一栏为什么空，而不是再抓一份同样会挂的源。

---

## 1. 从报告到产品：问题归因

### 1.1 用户实际能感知到的四件事

| 用户看到的现象 | 根因 | 代码位置 | 规模 |
| :--- | :--- | :--- | :--- |
| 同一条路透新闻在流里出现 4–8 次 | 译文漂移 → 文本指纹变 → 插入新行 | `newsText.ts:54` + `newsRepo.ts:62` | reuters 5 频道 3,141 行只对应 887 个 URL |
| 某频道突然"没新闻"，状态却是 ok | 解析失效返回 0 条被判 `empty`，不计数、不告警 | `sourcesRepo.ts:280`、`runner.ts:112` | jiemian / ngabbs / douban-group |
| 内容停在几小时前，界面没有任何提示 | `stale` 已下发给前端但无人消费 | `newsDb.ts:276` → `Stream.vue` 无引用 | 全部频道（前端均不读该字段） |
| 时间显示成 2001 年 / 公元前 | `getTime` 无上下界 | `getTime.ts:140` | qq-news、douban、newsmth |

### 1.2 一个报告略过的结构性事实（它决定了改造风险）

`news_hash` 名义上是"新闻指纹"，实际上有**两条互不相干的消费链**：

```
crawler  ──写入──▶  news_items.news_hash  ──只用于──▶  crawler 自己的 ON CONFLICT 幂等
backend  ──计算──▶  md5(source+title+desc) ──只用于──▶  user_news_states 的评分缓存/已读
```

证据：`queryNewsBySource` 的 SELECT 取了 `news_hash`（`newsDb.ts:586`），但返回给前端的 DTO 里**没有这个字段**（`newsDb.ts:607-616`）；后端评分是用前端回传的 `{source,title,desc}` **重新计算**哈希（`scorer.ts:129-151`）。

两个推论，直接改变方案：

1. **改 crawler 的指纹算法不需要三端同步发布**。报告把它当作"跨服务契约"来担心，实际不是——评分缓存不会因哈希公式变化而失效。
2. **反过来，只要展示文本（title/desc）变了，缓存就一定失效**。所以真正的省钱点是"翻译只写一次"，而不是"哈希稳定"。这也解释了为什么 A1 和 A2 必须成对设计。

### 1.3 `empty` 从来没有被验证过

`sourcesRepo.ts:280` 的空返回分支在 12 天、136 次抓取里 **0 次触发**。而 `enabled` 的软下架条件是 `consecutiveFailures < 5`（`newsDb.ts:290-293`）——只有 `failed` 会累加。结论：**静默空转永远不会被自动隐藏，也不会进 `/health` 的 `sources.failed` 计数**（那里只数 `failed`/`stuck`，`newsDb.ts:479-484`）。这是"频道突然没内容"的唯一解释路径，必须补。

---

## 2. 指标

| 类别 | 指标 | 定义 | 基线 | 目标 |
| :--- | :--- | :--- | :--- | :--- |
| 北极星 | 重复展示率 | 单频道最近 7 天 `行数 ÷ 唯一 URL 数` | 1.0–7.97（9 个频道 >1.5） | 全部 ≤ 1.05 |
| 护栏 | 评分缓存命中 | 命中 `user_news_states` 的条目占比 | 约 92% | 不得下降 |
| 护栏 | 抓取成功率 | `crawl_runs` 中 `ok/empty` ÷ 总数 | 94.1% | ≥ 99% |
| 护栏 | 单轮耗时 p95 | `runCrawlTask` 总时长 | 未采集 | ≤ 90s |
| 成本 | 翻译调用/日 | DeepSeek chat/completions 次数 | ≈ 2,160 | ≤ 600 |
| 健康 | 静默失效检出 | 已发生的静默空转中，能在 6h 内被标出的比例 | 0/3 | 3/3 |

基线口径与报告一致，采集 SQL 见 §8。

---

## 3. 方案总览

排序不看"技术难度"，只看两件事：**修不好的损失有多大**、**改动能不能单独回滚**。

| 顺位 | 工作项 | 为什么在这个位置 |
| :---: | :--- | :--- |
| 1 | A1 身份指纹 | 唯一"改完立刻见效"的项：一次迁移，重复行直接消失；且不依赖任何其他改动 |
| 2 | A3 时间闸门 | 和 A1 共用同一个写入点与同一次迁移，顺手做完，单独做也要发一次版 |
| 3 | B1 空转计数 | A2 的前置条件；单独上线时计数器恒为 0，无副作用 |
| 4 | B4 风控可读化 | 一个 if，收益是"下次 smzdm 失败时不用猜" |
| 5 | A2 翻译前置过滤 | 省 70% token，但会让 `written` 归零变得常见——必须排在 B1 之后 |
| 6 | C1 超时重试 | 独立、可灰度，失败率的主要来源 |
| 7 | B2 前端健康提示 | 依赖后端已下发的 `stale`，纯展示改动 |
| 8 | B3 整轮可观测 | 运维体验，不影响数据正确性 |
| 9 | C2 中转兜底 | 收益最小、且部分只能"接受"（路透无第二源） |

| 批次 | 工作项 | 改动面 | 依赖 | 何时可上 |
| :--- | :--- | :--- | :--- | :--- |
| **第一批** | A1、A3、B1、B4 | `newsText.ts`、`newsRepo.ts`、`sourcesRepo.ts`、`smzdm.ts`、migrations、1 个 CLI 命令 | 需停爬虫执行一次清理 | 单一发布窗口 |
| **第二批** | A2、C1、B2 | 3 个翻译适配器、`getData.ts`、`newsDb.ts`、`Stream.vue` | A1、B1 已上线 | 可独立灰度 |
| **第三批** | B3、C2 | `runner.ts`、`sourcesRepo.ts`、`bloomberg.ts` | 无 | 随时 |

---

## 4. 详细设计

### A1｜身份指纹：`news_hash` 从"文本指纹"改为"身份指纹"

**目标**：同一 URL 只存在一行，且这一行的展示文本**永不改写**。

**设计**

```ts
// crawler/src/utils/newsText.ts
export const buildNewsIdentity = (sourceName: string, subType: string, url: string): string => {
  const u = (url || "").trim();
  return u ? hashNewsText(`${sourceName}|${subType}|${u}`) : "";
};
```

- `buildNewsText` 增加入参 `sourceName` / `subType` / `url`，返回 `newsHash = identity || md5(formattedText)`。
  - 无 URL 的条目（极少数）退回文本指纹，行为与今天一致，不会退化。
  - `subType` 进键：同一故事出现在 `reuters` 与 `reuters-world` 时各留一行，符合"频道各自成栏"的产品语义；同时修掉今天"同文本跨 sub_type 互相抢行"的隐性丢数据。
- 落点：`newsRepo.ts:33` 传入 `options.sourceName` / `options.subType` / `item.url`。**这是唯一写入点**，其余 40 个适配器零改动。

**配套：改写入策略（关键，不能只改 hash）**

`newsRepo.ts:62-74` 现在的 `DO UPDATE` 会用新译文覆盖 `title/desc_text/formatted_text`。必须改成"首次非空即定稿"：

```sql
title           = CASE WHEN news_items.title != '' THEN news_items.title ELSE excluded.title END,
desc_text       = CASE WHEN news_items.desc_text != '' THEN news_items.desc_text ELSE excluded.desc_text END,
formatted_text  = CASE WHEN news_items.formatted_text != '' THEN news_items.formatted_text ELSE excluded.formatted_text END,
-- hot / cover / pub_time / mobile_url 仍按"新值非空则覆盖"更新
```

理由：文本一变，后端评分缓存立刻失效，同一批条目会被重复送去 DeepSeek 打分，用户已读状态也会漂移。**定稿 = 缓存永久命中**。

**代价**：突发新闻的标题后续被上游编辑时，这里不会跟进。可接受——这是一个"只读值得读的"榜单产品，不是实时通稿；需要刷新时用一次性命令 `--refresh-titles`（不在本方案实现）。

**数据迁移（一次性，必须先于代码上线）**

新增 `crawler/src/utils/dedupeNews.ts` + CLI 开关 `pnpm crawl --dedupe-news [--apply]`（默认 dry-run，与 `--doctor` 风格一致）。步骤：

1. 取 `id, source_name, source, sub_type, url`（`url != ''`）。
2. 按 `(source_name||source, sub_type, url)` 分组，**保留 `max(id)`**——即用户当前看到的那一行；删掉其余。
3. 对存活行重算 `news_hash = md5((source_name || source) + "|" + sub_type + "|" + url)`——与写入侧同参，缺一不可。
4. 顺带执行 A3 的时间清洗。
5. 自检：`SELECT COUNT(*) FROM (… GROUP BY 1,2,3 HAVING COUNT(*)>1)` 必须为 0。

预期结果：9,940 → 约 6,739 行（-32%）；reuters 5 频道 3,141 → 887 行。

**执行顺序**：停爬虫 → `--dedupe-news --apply` → 发布新代码 → 起爬虫。反序会在窗口期产生少量新重复行（不会丢数据，但要多跑一次清理）。

**验收**

```sql
-- 必须为 0，且连续 3 轮抓取后仍为 0
SELECT COUNT(*) FROM (
  SELECT source_name, sub_type, url FROM news_items
  WHERE url != '' GROUP BY 1,2,3 HAVING COUNT(*) > 1
);
```

**回滚**：代码回滚**不会**撤销重算后的 hash。为保持幂等，回滚时只回退 A2/B/C 的工作项，**保留 A1 的两处改动**（hash 公式 + 写入策略）；它们本身是自洽的最小单元。

---

### A2｜翻译前置过滤 + 同轮去重

**目标**：只翻译真正的新条目，把 DeepSeek 调用从"每轮 30 条"降到"每轮新增条数"。

**设计**

```ts
// crawler/src/db/newsRepo.ts
export const filterUnseenItems = async <T extends { url?: string }>(
  items: T[], sourceName: string, subType: string,
): Promise<T[]>
// 内部：对每个 item 用 buildNewsIdentity(sourceName, subType, item.url) 算身份，再分批
// `SELECT news_hash FROM news_items WHERE news_hash IN (…)`；命中的剔除，无 url 的一律保留
```

三个翻译适配器（`reuters.ts:76`、`bloomberg.ts:73`、`hackernews.ts:57`）在调用 `translateTexts` 之前插入一步：

```ts
const unseen = await filterUnseenItems(rawItems, "reuters", type);
// 只翻 unseen；未翻的条目原样留在列表里，写入时被"首次定稿"策略忽略（title 不会被英文覆盖）
```

`translator.ts` 另加两处小改：

- 按 `md5(text)` 做**单次调用内去重**：同一批里重复的标题只翻一次（报告中实测同轮重复率 43%）。
- `temperature: 0.1 → 0`，让冷启动的首次翻译可复现。

**为什么不做译文持久缓存**：A1 的"首次定稿"已经保证每个 URL 只翻一次，再加一张 `translate_cache` 表是重复投资，还会引入失效策略。等出现"同一文本跨频道复用"的真实需求再说。

**验收**：日志中 `[Translator] Successfully translated batch of N` 的 N 总和，单轮应 ≤ 新增条目数 × 2；连续 3 天 DeepSeek 调用量 ≤ 600/日。

**回滚**：单独回退三个适配器的调用即可，无数据影响。

---

### A3｜时间闸门

**目标**：消灭公元前/2001 年这类脏值。

**设计**（同样是唯一写入点，`newsRepo.ts:50`）

```ts
const MIN_PUB = Date.now() - 10 * 365 * 86400_000;  // 10 年前
const MAX_PUB = Date.now() + 2 * 86400_000;         // 容忍 2 天时区误差
const ts = Number(item.timestamp);
pubTime: Number.isFinite(ts) && ts >= MIN_PUB && ts <= MAX_PUB ? String(ts) : "",
```

越界即存空串，后端 `newsDb.ts:615` 已经回落到 `created_at`，前端不需要改。

**不做**在 `getTime.ts` 里加校验：那里被 40 个适配器共用，改一处会波及全部解析路径；写入点收口更安全。

**验收**：`SELECT COUNT(*) FROM news_items WHERE CAST(pub_time AS INTEGER) < 946684800000 AND pub_time != ''` 为 0。

---

### B1｜空转升级：让"没内容"变成一等状态

**目标**：静默空转在 3 轮（≈6 小时）内可被识别。

**设计**

- `sources` 增加 `consecutive_empty INTEGER NOT NULL DEFAULT 0`（migration `c004_supply_quality`）。
- `sourcesRepo.ts:273` 的 `updateSourceStatusSuccess`：`written > 0 → 0`，否则 `+1`。
- 后端 `toSourceItemDto`（`newsDb.ts:281`）派生：`consecutive_empty >= 3 → status = 'suspect'`，并在 `stats` 里加 `consecutiveEmpty`、`lastError`、`lastRunAt`。
- `/health` 的 `sources` 增加 `suspect` 计数。**注意现状**：`status` 只由"抓取滞后 > 2 个间隔"和 schema 版本决定（`newsDb.ts:493-503`），`stale/failed` 只是数字、不参与判定——所以 8 个源同时失败时 `/health` 仍返回 `ok`。本方案只补计数，是否让 `failed/suspect` 影响 `status` 单独决策（改它会误触发现有的运维报警规则）。

**关键：不要顺手自动下架。** `enabled` 的判定保持只看 `consecutiveFailures`。理由：`empty` 也可能是上游当天真的没更新（sspai、v2ex 天然稀疏）。自动隐藏一个"只是今天没新闻"的频道，比让它空着更糟。B2 负责把状态告诉用户，是否隐藏交给用户。

**一个必须锁死的前提**：`items_written` 的语义是"本轮处理的条目数"，**不是"新增行数"**。A2 的前置过滤不能改变这个语义——被过滤的条目仍要传给 `persistNewsSafely`（作为 no-op 更新）。否则健康的频道会因为"这轮没有新故事"被记成 `empty`，4 小时后 `stale=true`，健康度整体翻红。

**验收**：本地把某个适配器的返回值改成 `[]`，连续 3 轮后 `sources.status = 'suspect'`，`/sources` 的 `stats.consecutiveEmpty = 3`。

---

### B2｜健康语义前端化

**目标**：把后端已经在算的 `stale` 真正用起来。

**设计**

- 数据已经就位：`queryNewsBySource` 返回的 `res.stale` 存在 `sourceDataMap[key]`（`useStreamSources.js:108`），前端只是没读。
- `StreamSourceNav` 的频道项：`stale === true` 时加一个灰点 + tooltip「已 4 小时未更新」；`status === 'suspect'` 时用琥珀色点 + 「连续 3 轮无新内容」。
- 列表区：频道返回 `data.length === 0 && stale` 时，显示「该频道暂时没有新内容」而不是空白——空白无法区分"加载失败"和"真没东西"。

**不做**：不做健康度大屏、不做用户可订阅的告警。内部看 `/health` 与 `/sources` 就够。

**验收**：手动把某频道 `last_success_at` 改成 5 小时前，刷新页面能看到灰点与提示文案。

> **落地状态（2026-11-03，已实现，方案有修正）**
>
> 实施时发现一个前提错误：**`stale`（4h）不能用来判断「停更」**。crawler 每轮先释放本 route 的标题占用（`deduplicate.ts:107-108`），同一批旧条目会被重新 upsert 命中，`written > 0` 恒成立，`last_success_at` 因此每 2 小时刷新一次——内容冻结三周的 feed 也会显示「健康」。它只是**链路存活信号**。
>
> 实际落地的口径换成 `MAX(news_items.created_at)`（首次 INSERT 写入、冲突更新不覆盖）：`/sources` 新增 `stats.lastItemAt`，前端 `utils/sourceHealth.js` 用 24h（停更）/ 72h（长期停更）两档派生，标在 `StreamSourceNav` 圆点、`Setting` tag 与频道横幅上。`stale` 的 4h 语义保持不动，`/health` 仍用它。
>
> 同时顺带做了「48 小时可见窗口」（`NEWS_MAX_AGE_HOURS`，`GET /{name}?maxAge=`）：窗口内为空的频道返回 `hasOlder`，前端给「查看更早内容」回退，避免 `200 + data: []` 变成新的沉默失败。原设计里「`data.length === 0 && stale` 显示提示」的落点由 `hasOlder` + `lastItemAt` 承担。

---

### B3｜整轮可观测

`crawl_runs.run_id` 是**每信源一个**，所以现在无法回答"这一轮跑完了没有"。

- `crawl_runs` 增加 `batch_id TEXT NOT NULL DEFAULT ''` + 索引。
- `runner.ts:152` 的 `runCrawlTask` 生成一个 `batchId`，透传给 `crawlSingleTarget`。
- `/health` 增加 `lastBatch: { id, startedAt, finishedAt, targets, failed, items }`（按 `batch_id` 聚合最近一组）。

**验收**：`SELECT batch_id, COUNT(*), SUM(items_written), SUM(status='failed') FROM crawl_runs GROUP BY 1 ORDER BY MAX(started_at) DESC LIMIT 3` 每次抓取返回一行、38 个源。

---

### B4｜风控可读化（smzdm）

`smzdm.ts:52` 之前加形状校验：

```ts
if (!Array.isArray(result?.data?.data)) {
  throw new Error(`smzdm: 响应非预期 JSON（疑似 202 挑战页），前 80 字：${String(result?.data).slice(0, 80)}`);
}
```

把 `Cannot read properties of undefined (reading 'map')` 变成一句能直接搜到对策的话。同类守卫可以推广到全部"取嵌套字段"的适配器，但**只先做 smzdm**——它是唯一一个"同一份代码、本机 4/4 失败、生产成功"的源，误判成本最高。

---

### C1｜超时分级 + 一次重试

**目标**：把"境外链路抖动"从"整轮失败"降级为"延迟 8 秒"。

**设计**

- `getData.ts:45` 的 `get()` 支持 `options.timeout`（`axios` 已支持，只是没透传），默认仍取 `config.REQUEST_TIMEOUT`。
- 对 7 个境外/慢速适配器显式传 `timeout: 15000`：`reuters`、`bloomberg`、`hackernews`、`nytimes`、`hellogithub`、`v2ex`、`hostloc`（`github` 已自带 20s 与退避，不动）。
- 重试策略（只在 `get()` 内实现，POST 不重试）：

  | 情形 | 是否重试 | 理由 |
  | :--- | :--- | :--- |
  | `ECONNABORTED` / `ETIMEDOUT` / `ECONNRESET` | 是，1 次，400ms + 随机抖动 | 报告里 8 次失败全是这一类 |
  | 5xx / 504 | 是，1 次 | 上游维护窗口 |
  | 4xx（含 403/405） | 否 | 重试改变不了结果，只是把失败拖慢 |
  | 202（挑战页） | 否 | 见 B4 |

**成本**：最坏情况单源 30s（15s × 2），并发 3、38 个源 → 单轮上限约 6 分钟，仍在 2 小时窗口内。

**验收**：人为在 `getData` 里注入一次超时，日志出现 `retry 1/1` 且最终成功；连续 7 天 `crawl_runs.failed` ≤ 1%。

---

### C2｜中转单点：接受它，但标注它

`reuters` 5 频道 + `bloomberg` 2 频道全部走 `news.google.com/rss/search`，只换 `site:` 参数。给路透找第二个源是伪需求（路透早已关闭公开 RSS）。

**做两件小事**：

1. `bloomberg` 的 `world` / `technology` 增加降级：Google 失败时回落到 `feeds.bloomberg.com`（`markets` / `politics` 已经是官方源，说明这条路可用）。
2. `reuters` 的 `latest` 查询加 `when:1d` 限定，降低它与 `world/business` 的结果重叠——重叠本身不产生重复行（A1 已挡住），但会浪费翻译与打分。

**不做**：多中转商冗余、代理池、境外落地机。这些属于部署层，一旦要做应单独评估（见 `HANDOFF.md` 的 HTTPS 待办）。

---

## 5. 数据与命令变更清单

| 侧 | 变更 | 类型 | 兼容性 |
| :--- | :--- | :--- | :--- |
| crawler | `sources.consecutive_empty` | 新增列，默认 0 | 向后兼容，旧代码忽略该列 |
| crawler | `crawl_runs.batch_id` | 新增列，默认 '' | 同上 |
| crawler | `news_items.news_hash` **语义变更**（文本指纹 → 身份指纹） | 无结构变更 | 后端不消费，仅需更新 `docs/contracts/data-model.md` 的字段说明 |
| crawler | `pnpm crawl --dedupe-news [--apply]` | 新 CLI | 幂等，默认 dry-run |
| backend | `/sources` 的 `stats` 增加 `consecutiveEmpty` / `lastError` / `lastRunAt`；`status` 新增取值 `suspect` | 增量字段 | 前端按需读取，旧字段不变 |
| backend | `/health` 的 `sources` 增加 `suspect`；新增 `lastBatch` | 增量字段 | 兼容；`status` 判定不变 |

迁移编号沿用现有账本：`crawler_migrations` 加 `c004_supply_quality`（一次 `ALTER TABLE` ×2 + 索引）。

---

## 6. 实施顺序与验收门槛

| 步骤 | 动作 | 通过条件（不满足则停止） |
| :---: | :--- | :--- |
| 1 | 合并 A1 + A3 + B1 + B4 代码，**不发布** | `pnpm build` 通过；`--dedupe-news`（dry-run）输出的待删行数与 §0 估算同量级（±15%） |
| 2 | 停爬虫，执行 `--dedupe-news --apply` | 自检 SQL 返回 0；`SELECT COUNT(*) FROM news_items` ≈ 6,700 |
| 3 | 发布 crawler + backend，起爬虫，观察 3 轮 | 重复率 SQL 全部 ≤1.05；`failed` 为 0；`consecutive_empty` 恒为 0（A2 尚未上线，此时为空是正常的）；无 `suspect` |
| 4 | 合并 A2，灰度 1 个频道（reuters-technology） | 该频道单轮翻译条目数从 30 降到个位数；**`items_written` 仍为 30、`status` 仍为 `ok`**（这一条是 B1 语义的回归用例） |
| 5 | 全量 A2 + C1 + B2 | 翻译调用 ≤600/日；前端能看到灰点；`failed` ≤1% |
| 6 | B3 + C2 | `/health.lastBatch` 正确；bloomberg 回落路径可手动触发 |

每一步都可独立回滚，除步骤 2 的数据重写（单向）。

---

## 7. 风险与回滚

| 风险 | 触发条件 | 影响 | 处置 |
| :--- | :--- | :--- | :--- |
| 重算 hash 后旧代码回滚 | 回滚 crawler 到 A1 之前 | 旧代码用文本指纹，会重新产生重复行 | 回滚时**保留** `newsText.ts` + `newsRepo.ts` 的两处改动；它们是自洽单元 |
| `--dedupe-news` 误删 | 分组键取错（如漏了 `sub_type`） | 跨频道误删，不可逆 | 默认 dry-run；先在小库（本地 `data/news.sqlite`）跑一遍 diff；删除前导出 `id` 清单到 `logs/dedupe-<ts>.csv` |
| "首次定稿"导致标题不更新 | 突发新闻被上游改标题 | 展示旧标题 | 已知取舍；需要时用一次性 `--refresh-titles` |
| 前置过滤后 `written` 被误当新增数 | 有人把 `written` 改成"新增行数" | 健康频道被判 `empty` → 全站 `stale` | 在 `NewsRepo` 注释里锁死语义；B1 的验收用例专门覆盖 |
| 全局 15s 超时 | 误加到慢接口上 | 单轮变长 | 只允许 7 个白名单适配器传 `timeout`，其余用默认 6s |

---

## 8. 度量 SQL（生产 libSQL）

```sql
-- ① 重复率：上线后应全部 ≤ 1.05（created_at 是 ISO 串，必须按 date() 比较，不能和 datetime() 直接比）
SELECT source_name, sub_type,
       COUNT(*) AS rows, COUNT(DISTINCT url) AS urls,
       ROUND(1.0 * COUNT(*) / COUNT(DISTINCT url), 2) AS dup_ratio
FROM news_items
WHERE date(created_at) >= date('now', '-7 day') AND url != ''
GROUP BY 1, 2 ORDER BY dup_ratio DESC;

-- ② 抓取成败与空转
SELECT source_key, status, COUNT(*) n, SUM(items_written) items
FROM crawl_runs GROUP BY 1, 2 ORDER BY 1;

-- ③ 静默失效：连续空转 ≥3 的频道
SELECT key, status, consecutive_empty, last_success_at, last_error
FROM sources WHERE consecutive_empty >= 3 OR status = 'suspect';

-- ④ 内容新鲜度（无 pub_time 的频道只能看入库时间）
SELECT source_name, MAX(COALESCE(NULLIF(pub_time,''), created_at)) AS latest
FROM news_items GROUP BY 1 ORDER BY latest ASC;

-- ⑤ 整轮是否跑完
SELECT batch_id, COUNT(*) srcs, SUM(status='failed') failed, SUM(items_written) items,
       MIN(started_at) t0, MAX(finished_at) t1
FROM crawl_runs WHERE batch_id != '' GROUP BY 1 ORDER BY t0 DESC LIMIT 5;
```

---

## 9. 明确不做

| 想法 | 为什么不做 |
| :--- | :--- |
| 为每个信源维护代理/镜像 | 属于部署层，收益与维护成本不匹配；C1 的一次重试已覆盖大部分抖动 |
| 自动下架连续空转的信道 | 稀疏信道（sspai、v2ex）会被误杀；改为告警 + 用户可见 |
| 恢复 crawler 进程内缓存 | 2026-10-21 已证明读取路径命中率为 0（进程按轮重启、TTL < 间隔），恢复只会掩盖问题 |
| 给译文加持久缓存表 | A1 的"首次定稿"已让每个 URL 只翻一次 |
| 补 7 个频道的 `pub_time` | github/v2ex/hupu 的源站确实没有发布时间；后端已回落 `created_at`，强行补只会造假数据 |
| 全量接入 10 个未上架适配器 | `linuxdo`/`producthunt`（403 Cloudflare）、`earthquake`（405）当前不可用；其余 7 个属于产品决策，不属质量优化 |
| 前端做健康度大屏 | 内部有 `/health` 与 `/sources` 足够；面向用户的只需"这栏为什么空"一句话 |

---

## 附：与报告的映射

| 报告 §8 优先级 | 本方案 |
| :--- | :--- |
| P0 指纹改用翻译前原文 | A1（改为 URL 身份指纹，比"原文标题"更稳）+ A2 |
| P0 smzdm 响应体判定 | B4 |
| P1 超时分级 | C1 |
| P1 `empty` 连续升级 | B1 |
| P1 补 `pub_time` | 不做（见 §9），仅 A3 清洗脏值 |
| P2 同 URL 存在则跳过 | 由 A1 在约束层解决，无需额外查询 |
| P2 清理死代码 | 不做（保留 `linuxdo` 等作为候选，`retired` 已隔离） |
| P2 `batch_id` | B3 |
| （报告未列） | B2 前端健康提示、C2 中转兜底 |
