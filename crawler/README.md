# crawler · 新闻爬虫服务

DailyForYou 的抓取侧服务，默认监听 **6688**。只负责抓取信源、翻译英文资讯、把结果写入 `news_items`；**不处理用户、不做评分**。

用户与评分由同级的 [`backend/`](../backend) 服务负责（:6690）。

## 职责边界

| 项 | 说明 |
| :--- | :--- |
| 拥有的表 | `news_items`（新闻正文与翻译结果） |
| 迁移账本 | `crawler_migrations`（`c001_news_schema`） |
| 不做什么 | 不读写用户表、不调用评分、不依赖登录态 |
| 接口性质 | 公开只读榜单 API |

## 运行

```bash
pnpm install
cp .env.example .env       # 填 DEEPSEEK_API_KEY 与数据库
pnpm dev                   # http://localhost:6688
```

需要 **Node.js ≥ 22.5**。

## 环境变量

| 变量 | 说明 |
| :--- | :--- |
| `PORT` | 默认 `6688` |
| `CACHE_TTL` | 抓取结果缓存秒数，默认 `3600` |
| `REQUEST_TIMEOUT` | 上游请求超时（毫秒），默认 `6000` |
| `NEWS_PERSIST_ENABLED` | 是否把抓取结果写入 `news_items`，默认 `true` |
| `RSS_MODE` | 是否全局输出 RSS |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` | 翻译用 |
| `SQLITE_DB_PATH` / `LIBSQL_URL` / `LIBSQL_AUTH_TOKEN` | 数据库连接 |

## API

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| GET | `/{source}` | 拉取单个信源，`?cache=false` 强制刷新，`?limit=30` 限制条数，`?rss=true` 输出 RSS |
| GET | `/all` | 全部信源清单 |

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
