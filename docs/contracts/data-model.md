# 数据模型（唯一副本）

> 本文件是表结构的**唯一权威副本**。`crawler.md` 和 `backend.md` 只引用，不复制 DDL——两份 schema 必然漂移。
> 改表结构等于改契约：先改本文件，再改代码，并递增 `schema_meta` 的版本号。

---

## 0. 产品视角：每张表都是一个承诺

表结构通常被当成实现细节，但这里每张表都直接对应一句对用户的承诺。改表之前，先看违约的样子：

| 表 | 对用户的承诺 | 违约时用户看到 |
| :--- | :--- | :--- |
| `sources` | 你看到的频道真实存在，而且知道它新不新 | 停更两天的频道；凭空多出的空频道 |
| `source_logos` | 每个源都有脸 | 一排裂图，或一排文字 |
| `news_items` | 打开就有东西读 | 白屏；昨天的报纸 |
| `schema_meta` | 升级不会炸 | 500，或字段缺失导致的空列表 |
| `crawl_runs` | 出问题能复盘 | 排障只能靠猜 |
| `users` / `user_news_states` | 我的判断是我的 | 改分被覆盖；换账号串读 |

### 0.1 三个改起来最贵的决定

1. **`key` 永不变。** 用户的开关、排序、已读、`localStorage` 全挂在 `key` 上。改一次 `key` 等于清空一批用户的偏好，而且不会有任何报错。
2. **永不物理删除。** 用 `retired = 1`。删行会让 `news_items` 里的历史数据变成无主记录，统计与回填都会出错。
3. **时间一律 ISO 8601 UTC。** 混用 Unix 时间戳会让 `stale` 判断和前端排序在时区边界上错乱，且极难复现。

### 0.2 一张表的两个身份

`sources` 同时是**清单**与**心跳**。合并而不是拆开，是因为两者天然同频更新：清单变了要抓一轮，抓完就要写状态。拆成两张表只会多出「清单有、状态无」的中间态，而这个中间态没有任何产品含义。

---

## 1. 归属与读写权限

| 表 | 写入方 | 读取方 | 迁移账本 |
| :--- | :--- | :--- | :--- |
| `news_items` | **仅 crawler** | backend、crawler | `crawler_migrations` |
| `sources` | **仅 crawler** | backend、crawler | `crawler_migrations` |
| `source_logos` | **仅 crawler**（`--sync-logos`） | backend | `crawler_migrations` |
| `schema_meta` | crawler | backend | `crawler_migrations` |
| `crawl_runs`（可选） | crawler | backend | `crawler_migrations` |
| `users` / `auth_*` / `user_profiles` / `user_news_states` | **仅 backend** | backend | `user_migrations` |

约束：**backend 对 crawler 的表只有 `SELECT`**。不靠数据库权限强制，而靠一条纪律——`backend/src/utils/newsDb.ts` 是唯一允许出现 `news_items` / `sources` 表名的文件。

---

## 2. 三个标识，别混用

| 字段 | 例子 | 谁用 | 作用 |
| :--- | :--- | :--- | :--- |
| `key` | `reuters-world` | 前端 UI、`localStorage`、`/logo/:key.png` | 稳定标识，**永不变** |
| `name` | `reuters` | 请求路径 `/reuters`、DB `source_name` | 适配器名 |
| `sub_type` | `world` | 请求 query `?type=world`、DB `sub_type` | 子类型，无则为空串 |

`key` 与 `name` 分离是这套设计的核心收益：前端不再靠 `type.startsWith("reuters-")` 这类前缀猜测拼 URL，新增子类型无需改前端代码。现有的 `key` 值恰好等于前端 UI 里的名字（`jiemian-hot`），所以老用户 `localStorage` 不需要迁移。

---

## 3. `sources` — 清单 + 状态

一张表同时承担两个角色：**媒体清单**（`GET /sources` 的数据源）与**抓取心跳**（后端据此判断爬虫死活）。

```sql
CREATE TABLE IF NOT EXISTS sources (
  key                  TEXT PRIMARY KEY,          -- 稳定标识：reuters-world
  name                 TEXT NOT NULL,             -- 请求路径 / DB 的 source_name：reuters
  sub_type             TEXT NOT NULL DEFAULT '',  -- DB 的 sub_type：world
  params_json          TEXT NOT NULL DEFAULT '{}',-- 请求 query：{"type":"world"}
  label                TEXT NOT NULL,             -- 路透社·国际
  category             TEXT NOT NULL DEFAULT '',  -- 财经（前端分组用）
  type                 TEXT NOT NULL DEFAULT '',  -- 国际（卡片副标题）
  link                 TEXT NOT NULL DEFAULT '',

  logo_url             TEXT NOT NULL DEFAULT '',  -- 可选：外链，优先级最高
  logo_text            TEXT NOT NULL DEFAULT '',  -- 文字徽标文案（「财」「路」）
  logo_color           TEXT NOT NULL DEFAULT '#5F5E5A',
  has_logo             INTEGER NOT NULL DEFAULT 0, -- 1 = source_logos 里有二进制
  logo_etag            TEXT NOT NULL DEFAULT '',

  sort_order           INTEGER NOT NULL DEFAULT 0,
  default_on           INTEGER NOT NULL DEFAULT 1,

  enabled              INTEGER NOT NULL DEFAULT 1,   -- 人工开关
  retired              INTEGER NOT NULL DEFAULT 0,   -- 注册表已移除，保留历史

  status               TEXT NOT NULL DEFAULT 'idle', -- idle|running|ok|empty|failed
  last_started_at      TEXT NOT NULL DEFAULT '',
  last_finished_at     TEXT NOT NULL DEFAULT '',
  last_success_at      TEXT NOT NULL DEFAULT '',
  last_error           TEXT NOT NULL DEFAULT '',
  items_total          INTEGER NOT NULL DEFAULT 0,   -- 该源在 news_items 的总条数
  items_last_run       INTEGER NOT NULL DEFAULT 0,   -- 最近一次写入/更新条数
  consecutive_failures INTEGER NOT NULL DEFAULT 0,

  updated_at           TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sources_order ON sources(sort_order);
```

字段分三组，改动时的纪律不同：

| 组 | 字段 | 写入时机 | 谁可以改 |
| :--- | :--- | :--- | :--- |
| 元数据 | `key` `name` `sub_type` `params_json` `label` `category` `type` `link` `logo_*` `sort_order` `default_on` | 启动对账 | crawler 注册表覆盖 |
| 运维 | `enabled` `retired` | 人工 | 只 `UPDATE`，不 `DELETE` |
| 状态 | `status` `last_*` `items_*` `consecutive_failures` `updated_at` | 每轮抓取 | 只有 crawler 写 |

**`enabled` 与 `retired` 是两件事**：`enabled = 0` 是临时下架（适配器挂了、源改版待修），前端灰显；`retired = 1` 是永久下架（注册表里已经删了），清单里不再返回，但行保留。

**永不物理删除。** 删了行，`news_items` 里的历史数据就再也没有名字，统计查询会冒出一堆无主记录。

---

## 4. `source_logos` — 图标二进制

```sql
CREATE TABLE IF NOT EXISTS source_logos (
  key         TEXT PRIMARY KEY,              -- 与 sources.key 一一对应
  mime        TEXT NOT NULL,                 -- image/png | image/svg+xml | image/webp
  bytes       BLOB NOT NULL,                 -- 原图，限 256KB
  width       INTEGER NOT NULL DEFAULT 0,
  height      INTEGER NOT NULL DEFAULT 0,
  source_file TEXT NOT NULL DEFAULT '',      -- 原始文件名，便于追溯
  updated_at  TEXT NOT NULL
);
```

**为什么不把 `bytes` 直接放进 `sources`**：`/sources` 是最高频接口之一，`SELECT * FROM sources` 一旦带上 50 × 30KB 的 blob，每次请求就是 1.5MB。拆表后清单查询完全不碰二进制，`/logo/:key` 按需单独取。两张表靠 `key` 关联，`sources.has_logo` 只是给清单用的标记位。

---

## 5. `schema_meta` — 版本握手

```sql
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- seed: ('news_schema_version', '3')
```

crawler 迁移时递增，backend 启动时读一次与 `EXPECTED_NEWS_SCHEMA` 比对。不匹配打 `WARN` 但**不阻塞启动**——新闻是只读的，字段多了不影响，字段少了才可能报错，由 `/health` 暴露为 `degraded`。

这解决"crawler 加了字段、backend 还没发"的灰度窗口问题。

---

## 6. `crawl_runs` — 历史（可选，P2）

只在需要回答"昨天那轮为什么失败"时才需要。`sources` 表的当前状态字段已经够用。

```sql
CREATE TABLE IF NOT EXISTS crawl_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL,
  source_key    TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'running',
  items_written INTEGER NOT NULL DEFAULT 0,
  error         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_crawl_runs_key ON crawl_runs(source_key, started_at DESC);
```

保留 7 天，每轮任务启动时清理。

---

## 7. `news_items` 写入不变量

现有实现基本满足，此处固化为契约：

1. `news_hash` 唯一，重复抓取走 `ON CONFLICT DO UPDATE`（幂等）。
2. `source_name` 必填且等于 `sources.name`；`sub_type` 等于 `sources.sub_type`（无子类型则为空串）。
3. `source` 字段保留中文 label（历史兼容 + 回填用），但**不得作为查询主键**。
4. `created_at` 是"首次入库时间"，`updated_at` 是"最后一次被看到的时间"。
5. 单条入库失败不得中断整批（`persistNewsSafely` 已保证）。

---

## 8. 三个容易写错的地方

**`items_total` 必须用子查询实时算，不能累加。**

```sql
items_total = (SELECT COUNT(*) FROM news_items WHERE source_name=? AND sub_type=?)
```

Upsert 会更新已有行，`+=` 累加会越算越虚。

**`status='running'` 会残留。** 进程被 kill 时来不及写 `finished`。读取方必须把"`status='running'` 且 `last_started_at` 超过 30 分钟"当成 `stuck`，等价于 `failed`，否则这个源永远显示"抓取中"。

**时间一律存 ISO 8601 UTC 字符串**（`2026-10-20T08:21:36.530Z`），与现有 `news_items` 一致。不要混用 Unix 时间戳，否则 `stale` 计算与前端排序会出现时区错乱。
