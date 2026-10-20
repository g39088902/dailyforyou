# backend · 用户服务

DailyForYou 的用户侧服务，默认监听 **6690**。只负责钱包登录、用户配置、评分与 Prompt 管理；**不抓取、不翻译、不写入新闻正文**。

榜单抓取由同级的 [`crawler/`](../crawler) 服务负责（:6688）。

## 职责边界

| 项 | 说明 |
| :--- | :--- |
| 拥有的表 | `users`、`auth_identities`、`auth_nonces`、`user_profiles`、`user_news_states` |
| 迁移账本 | `user_migrations`（`u001_core_schema` → `u003_state_index_fields`） |
| 不做什么 | 不访问源站、不调用翻译、运行期不读取 `news_items` |
| 索引方式 | 评分时把 `source/title/url` 作为最小索引写进 `user_news_states` |

## 运行

```bash
pnpm install
cp .env.example .env       # 填 AUTH_JWT_SECRET、DEEPSEEK_API_KEY、数据库
pnpm dev                   # http://localhost:6690
```

需要 **Node.js ≥ 22.5**。数据库支持本地 `node:sqlite`（`SQLITE_DB_PATH`）与远程 libSQL（`LIBSQL_URL`）。

## 环境变量

| 变量 | 说明 |
| :--- | :--- |
| `PORT` | 默认 `6690` |
| `AUTH_JWT_SECRET` | 必填，`openssl rand -hex 32` |
| `AUTH_JWT_TTL` / `AUTH_NONCE_TTL` | 令牌 7 天 / 挑战 5 分钟 |
| `AUTH_DOMAIN` / `AUTH_URI` | 登录消息中的域名与 URI |
| `DEFAULT_USER_ID` / `DEFAULT_USER_ADDRESS` | 默认账户与承接历史数据的钱包地址 |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` | 评分用 |
| `SCORE_PROMPT_MAX_LENGTH` | 自定义 Prompt 长度上限 |
| `SCORE_RATE_LIMIT_PER_MIN` / `PROMPT_TEST_RATE_LIMIT_PER_MIN` | 评分与试跑限流 |

## API

所有 `/score*`、`/account*`、`/auth/me` 需要 `Authorization: Bearer <JWT>`。

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| POST | `/auth/nonce` | 申请一次性签名挑战 |
| POST | `/auth/verify` | 校验签名并签发 JWT |
| GET | `/auth/me` | 当前用户与身份 |
| GET | `/auth/providers` | 可用登录渠道（微信/手机号为 501 占位） |
| GET | `/account/profile` | 账户概览 |
| GET/PUT | `/account/prompt` | 读取 / 保存自定义 Prompt |
| POST | `/account/prompt/reset` | 恢复默认 Prompt |
| POST | `/account/prompt/test` | 试跑一次，不落库 |
| GET/POST/PUT/PATCH | `/score*` | 评分、缓存查询、手动修正、已读同步 |

## 脚本

```bash
node scripts/backup-scores.mjs          # 迁移前备份
node scripts/login-e2e.mjs              # 临时钱包跑通登录+评分+隔离（自动清理）
node scripts/rollback-user-states.mjs --confirm   # 紧急回灌到旧表
```

## 多用户约定

- 评分缓存命中条件：`ai_score >= 0 && prompt_hash == md5(当前 Prompt)`，或 `is_user_modified = 1`。
- 任何按主键的读写都必须带 `user_id`，禁止跨用户访问。
- 修改 Prompt 会让旧 AI 评分自动失效，但不会清除手动修正。
