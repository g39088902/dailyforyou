# 三层契约总览（前端 ↔ 后端 ↔ 爬虫）

> 让"系统里有哪些媒体"只有一个答案，让每一层的职责边界可以被代码验证，而不是靠人记。

按服务拆成四份，**只看自己那页就够**：

| 文档 | 谁看 | 讲什么 |
| :--- | :--- | :--- |
| [`data-model.md`](./data-model.md) | 三方（改表时必读） | 表结构与字段语义的**唯一副本** |
| [`crawler.md`](./crawler.md) | 爬虫 | 注册表、对账、状态写入时序、图标入库 |
| [`backend.md`](./backend.md) | 后端 | `/sources`、`/logo`、`/health`、错误语义 |
| [`frontend.md`](./frontend.md) | 前端 | 删什么、状态模型、降级、图标用法 |

---

## 0. 一句话结论

- **清单存在数据库的一张表里**：爬虫每轮抓取时把"我是谁、我抓到什么状态"写进 `sources` 表，后端读表并通过 `GET /sources` 下发给前端。
- **logo 也在数据库里**：二进制单独存 `source_logos`，后端用 `GET /logo/:key.png` 统一出图；无图时动态生成文字徽标，保证永不裂图。前端不再维护 `public/logo/`。
- **前端 ↔ 后端**：前端只保存"用户开关与排序"这类个人偏好，不再持有业务清单。
- **后端 ↔ 爬虫**：继续以共享 libSQL 为集成点，`sources` 表就是两者之间的契约（既是清单，也是心跳）。
- **不引入**：配置文件 + 代码生成、HTTP ingest、消息队列。

---

## 1. 依赖方向

```
frontend  ──GET /sources, /{name}, /logo──▶  backend  ──SELECT──▶  libSQL  ◀──写──  crawler
    │                                            │                                  │
    └────────── 不知道爬虫存在 ───────────────────┘        不知道后端/前端存在 ─────┘
```

单向依赖带来两个可以直接检查的性质：

- 前端代码里 grep 不到媒体名；
- 爬虫代码里没有任何 HTTP 服务端代码。

---

## 2. 为什么是数据库表，不是配置文件

| 方案 | 缺点 |
| :--- | :--- |
| 前端内置清单（现状） | 后端/爬虫改了前端不知道，三份清单漂移 |
| 根目录 `sources.json` + 代码生成三端产物 | 多一套生成与校验脚本；改一条清单必须重新构建并部署三个服务；生成物与源文件容易失同步 |
| **数据库 `sources` 表**（采用） | 需要一个 seed 机制，且清单变更要跑一次爬虫或 CLI |

选第三条的理由：**爬虫已经连库了，而清单本来就是"爬虫能力的投影"**。谁最清楚有哪些源、每个源上次抓到没有？只有爬虫自己。让它写完顺手记一笔，比在构建期维护第二份真相可靠得多。

"清单变更要跑一次爬虫"这个缺点也是优点：变更天然被记录、可审计、可回滚。

---

## 3. 现状诊断

### 3.1 四份清单 + 两处事实

| 位置 | 性质 | 内容 | 数量 |
| :--- | :--- | :--- | ---: |
| `frontend/src/store/index.js` `defaultNewsArr` | 清单 ① | UI 频道（label / name / order / show / params） | 27 |
| `backend/src/utils/newsDb.ts` `SOURCE_METADATA_MAP` | 清单 ② | 查询用的 meta（title / type / link） | 32 |
| `crawler/src/runner.ts` `DEFAULT_TARGETS` | 清单 ③ | 抓取目标（sourceName / subType / label） | 30 |
| `frontend/public/logo/` | 清单 ④ | 图标文件，按 UI 名命名 | 32 |
| `crawler/src/routes/*.ts` | 事实 | 真实存在的适配器 | 43 |
| 生产库 `news_items` | 事实 | 实际有数据的 `source_name + sub_type` 组合 | 49 |

四份清单互不同步，而"事实"又谁都对不上——这就是本次要收口的东西。

### 3.2 六种沉默失败（均已实测确认）

1. **三个幽灵源**：`DEFAULT_TARGETS` 含 `ngabbs` / `weibo` / `zhihu`，但 `crawler/src/routes/` 下这三个适配器文件**都不存在**。每轮抓取必然失败并写错误日志。
2. **现网就有一个坏频道**：前端 27 个频道里的"NGA"（`ngabbs`）正是幽灵源之一。生产 `/feed/ngabbs` 返回 `total:1`，唯一一条数据是 `2026-10-18`——两天前。用户看到的是"永远停在两天前的频道"，而没有任何地方会告诉他爬虫早就不抓了。
3. **隐身源**：`sina` 适配器存在、库里 30 条数据，但前端 27 个频道里没有 → 抓了没人看。另有 **22 个适配器**完全不在任何清单里（`51cto`、`csdn`、`hupu`、`huxiu`、`ifanr`、`nytimes`、`producthunt`、`smzdm`、`sina-news` 等）。
4. **静默空频道**：`backend` 元数据认 `weibo`/`zhihu`，`GET /weibo` 返回 `200 + total:0`。前端若加一个频道，得到的是永远空白且不报错的卡片。
5. **清单接口已下线**：`GET /all` 已于 2026-10-21 移除（其 `routes[].path` 是 `"/reuters:world"` 这种冒号键，本身无法驱动前端）。在 `/sources` 落地前，前端不得依赖任何清单接口。
6. **图标是第四份清单**：`public/logo/` 按 UI 名命名（`jiemian-hot.png`），与 `source_name`（`jiemian`）不同源；少一张就 404，而两处容错还不一致——`StreamSourceNav.vue` 用 `@error` 静默隐藏，`Setting.vue` 直接裂图。

### 3.3 为什么现在还不痛

因为只有一个部署、一个人维护、27 个频道半年没变。一旦要加第 28 个媒体，就要改 4 个文件，且漏改任何一处都不会报错——只会静默少一个频道或多一个空频道。典型的**沉默失败**，必须在规模扩大前收口。

---

## 4. 设计原则

1. **单一事实来源**：清单只存在于 `sources` 表；代码里只有一份"注册表常量"，它是这张表的种子与对账依据。
2. **单向依赖**：前端 → 后端 → 数据库 ← 爬虫。前端**不允许**知道爬虫的存在；爬虫**不允许**知道后端的存在。
3. **契约可验证**：注册表与适配器文件的一致性由爬虫启动时校验，不靠 review。
4. **失败要响**：空信源、陈旧信源、停摆的爬虫都必须可观测，而不是返回 200 空数组。

---

## 5. 为什么后端 ↔ 爬虫不改成 HTTP ingest

- 爬虫是离线批处理，天然适合"写库即完成"。引入 API 会带来鉴权、幂等键、部分失败重试、双写一致性四类复杂度。
- 共享 libSQL 天然支持跨机（HTTP 协议），"爬虫换一台机器"这个需求已被满足。
- 当前数据量（单表单日千级写入）远未到需要消息队列的程度。

**什么时候该改**：出现多个抓取节点需要独立扩缩容、或需要把数据开放给第三方系统时。届时把 `persistNewsSafely` 换成一个 HTTP 客户端即可，因为写入侧已经被 `crawler/src/db/newsRepo.ts` 单点封装了。

---

## 6. 发布顺序

改动只能按这个顺序发，每一步都只增不改：

1. **crawler 先行** — 加 `c003_sources_registry` 迁移（建 `sources` / `source_logos` + seed），跑一次 `--sync-logos` 把图灌进库，之后开始写状态字段。对旧 backend 完全无害（它不认识这两张表）。
2. **backend 跟进** — 加 `/sources` / `/logo/:file` / `/health`，`SOURCE_METADATA_MAP` 改为查表（带 60s 缓存）。旧前端仍用旧接口，不受影响。
3. **frontend 最后** — 切到 `/sources` 与后端下发的 `logo`。若前端先发而接口 404，走 snapshot / 空态不会白屏；图标回落 `public/logo/`（此时还没删），天然平滑。

回滚任意一层都不会让另外两层报错。`/:source` 的语义在整个过程中不变。

---

## 7. 分期与归属

以服务为列，一眼看出"我这轮要不要动"：

| 阶段 | crawler | backend | frontend |
| :--- | :--- | :--- | :--- |
| **P0**<br>1–1.5 天 | 裁决幽灵源（`ngabbs`/`weibo`/`zhihu`）；`sources` + `source_logos` 建表与 seed；`reconcileSources()`；状态写入时序；`--sync-logos` 灌 32 张图 | `/sources`、`/logo/:file`、`/health`；未知信源改 404；`SOURCE_METADATA_MAP` 改为查表 | — |
| **P1**<br>0.5–1 天 | — | — | 删四份硬编码清单；切 `/sources` + `sourcePrefs` + snapshot 降级；图标改用下发路径 |
| **P2**<br>可选 | `crawl_runs` 历史表、`--doctor` | `/:source` 游标分页（现在固定 `LIMIT 30`，Stream 加载不了更多） | `stale` 标记、"数据滞后"提示 |

空单元格是刻意的：**P1 只有前端需要发布**，crawler 与 backend 在 P0 完成后即可停手。每个阶段的详细任务与验收标准写在各服务的文档里，不在本页重复。

---

## 8. 全局验收（跨三方的性质）

- [ ] 媒体名在代码里只出现在 `crawler/src/data/sourceRegistry.ts`（`backend` / `frontend` 的 `src` 下 grep 不到具体媒体）
- [ ] `sources` 表是清单唯一来源；改一条 label 只需 `UPDATE sources`，前端刷新即生效（不重新构建）
- [ ] 新库部署后、爬虫首轮抓取前，`/sources` 就有完整清单（seed 生效）
- [ ] 爬虫停摆 5 分钟内可见（`/health` 变 `degraded`，`/sources` 全量 `stale`）
- [ ] 新增一个媒体只改 `crawler/src/data/sourceRegistry.ts` + 新增适配器，前后端零改动
- [ ] 任意源在任意环境都有图（200，不是 404、不是裂图）
- [ ] 回滚任意一层不会让另外两层报错
