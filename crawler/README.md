# crawler · 新闻爬虫调度器

DailyForYou 的离线/定时抓取调度器，**不提供 HTTP 服务，不监听任何网络端口**。只负责定时抓取信源、翻译英文资讯、把结果单向写入 `news_items` 表。

用户、评分以及从数据库中供给新闻 API 统一由 [`backend/`](../backend) 服务负责（:6690）。

## 职责边界

| 项 | 说明 |
| :--- | :--- |
| 拥有的表 | `news_items`（新闻正文与抓取元数据） |
| 迁移账本 | `crawler_migrations`（`c001_news_schema`, `c002_news_columns`） |
| 不做什么 | **不启动 HTTP 服务**、不提供 Web 接口、不读写用户表、不做评分 |
| 运行方式 | CLI 单次执行（`pnpm crawl`）或后台定时轮询（`pnpm crawl:daemon`） |
| 部署环境 | **推荐部署于具备家用宽带的物理机**（出站抓取、单向出站写入云端 libSQL） |

## 运行

```bash
pnpm install
cp .env.example .env       # 填 DEEPSEEK_API_KEY 与云端数据库 LIBSQL_URL

# 单次抓取测试（指定信源或全部）
pnpm crawl cls
pnpm crawl

# 启动常驻定时调度器（Daemon 模式，按间隔周期循环执行）
pnpm crawl:daemon
```

需要 **Node.js ≥ 22.5**。

## 环境变量

| 变量 | 说明 |
| :--- | :--- |
| `CRAWL_INTERVAL_MINUTES` | Daemon 轮询间隔（分钟），默认 `120`（2 小时） |
| `REQUEST_TIMEOUT` | 上游抓取请求超时（毫秒），默认 `6000` |
| `NEWS_PERSIST_ENABLED` | 是否把抓取结果写入 `news_items`，默认 `true` |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` | 英文信源翻译用 |
| `SQLITE_DB_PATH` / `LIBSQL_URL` / `LIBSQL_AUTH_TOKEN` | 远程 libSQL 或本地 SQLite 连接 |

## 数据出口

本服务不提供 HTTP 接口。抓取结果由 `src/db/newsRepo.ts` 直接 upsert 到共享库的 `news_items` 表，
对外查询统一由 backend 的 `GET /:source` 提供。

## 新增信源

1. 在 `src/routes/` 新建 `<sourceName>.ts`，导出 `handleRoute(c, noCache)`。
2. 用 `../utils/getData.js` 的 `get/post` 抓取，`cheerio` 解析 HTML，`parseRSS` 解析 RSS。
3. 返回 `RouterData`，`data` 为 `ListItem[]`（至少含 `id/title/url`）。
4. 无需改 `registry.ts`：启动时会自动扫描并注册。
5. 前端需要在 `frontend/src/store/index.js` 的 `defaultNewsArr` 登记同名字段。

## 入库行为

- 仅当本次请求**未命中缓存**（`fromCache === false`）时写入，避免重复写库。
- 去重后按 `(source, title, desc)` 生成 `news_hash`，批量 `upsert` 到 `news_items`。
- 翻译在适配器内完成，入库的是翻译后的标题与摘要。
- 入库失败只记录日志，不影响接口返回。
