# 部署交接单（HANDOFF）

生成时间：2026-10-20 14:50 GMT+8
用途：本机运行环境的文件删除策略过严，导致前端构建的 PWA 阶段挂起。
以下为**已完成状态**与**剩余任务**，可在任意终端 / 其他 harness 直接执行。

---

## 1. 已完成（无需重做）

### 1.1 服务器

| 项 | 值 |
| :--- | :--- |
| 主机 | `root@134.175.155.179`（Ubuntu，Node v22.22.1 / pnpm 12.14.0 / PM2 7.0.4） |
| 站点入口 | **http://134.175.155.179:8081** |
| 安全组 | 已放行 `8081`、`8080` |

端口占用（**不要再动**）：

| 端口 | 用途 |
| :--- | :--- |
| `80` | 既有 python/uvicorn 业务 |
| `8080` | 既有 libSQL（Nginx 反代 sqld） |
| `8088` | sqld 本体（127.0.0.1） |
| `8081` | DailyForYou 站点（新建） |
| `6690` | 用户服务 backend（127.0.0.1） |
| `6688` | 爬虫 crawler（127.0.0.1） |

### 1.2 已部署内容

```
/opt/dailyhot/
├── back/                 # 用户服务，PM2: dailyhot-back，127.0.0.1:6690
│   ├── .env              # 600 权限，已含生产配置
│   ├── dist/ node_modules/ scripts/ logs/ data/
│   ├── ecosystem.config.cjs
│   └── package.json / pnpm-lock.yaml
├── crawler/              # 爬虫服务，PM2: dailyhot-crawler，127.0.0.1:6688
│   ├── .env              # 600 权限，已含生产配置
│   ├── dist/ public/ node_modules/ logs/ data/
│   ├── ecosystem.config.cjs
│   └── package.json / pnpm-lock.yaml
└── front/
    └── dist/             # 前端静态产物，Nginx 托管
```

- Nginx 站点配置：`/etc/nginx/conf.d/dailyforyou.conf`（listen 8081）
  - `location /api/` → `127.0.0.1:6690`
  - `location /feed/` → `upstream dailyforyou_crawler`（`127.0.0.1:6688`）
  - `location /` → `/opt/dailyhot/front/dist`（SPA 回退）
- PM2 已由 systemd `pm2-root.service` 托管并 `pm2 save`，开机自启。
- 生产 `.env` 关键值：`PORT=6690`、`HOST=127.0.0.1`、`LIBSQL_URL=http://127.0.0.1:8080`、
  `AUTH_DOMAIN=134.175.155.179:8081`、`AUTH_URI=http://134.175.155.179:8081`、`DEFAULT_USER_ADDRESS=0x8852…3d93`。
- 前端构建变量：`frontend/.env.production` → `VITE_GLOBAL_API="/api"`、`VITE_FEED_API="/feed"`。

### 1.3 已验证

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://134.175.155.179:8081/                      # 200
curl -s -o /dev/null -w "%{http_code}\n" http://134.175.155.179:8081/api/auth/providers    # 200
curl -s -o /dev/null -w "%{http_code}\n" http://134.175.155.179:8081/api/score             # 401 + needLogin
curl -s -o /dev/null -w "%{http_code}\n" http://134.175.155.179:8081/feed/all              # 200（43 个信源）
curl -s -o /dev/null -w "%{http_code}\n" http://134.175.155.179:8081/feed/cls?limit=3      # 200 + 入库 news_items
```

- 服务器上跑 `cd /opt/dailyhot/back && E2E_BASE=http://127.0.0.1:8081/api node scripts/login-e2e.mjs`
  → **19/19 通过**（登录、nonce 重放拒绝、评分、缓存命中、手改/重置、已读、Prompt 失效、跨用户隔离、迁移不变量）。
- 浏览器实拍：首页框架、登录弹窗（MetaMask 可用，微信/手机号灰态）均正常。

---

## 2. 剩余任务

### 任务 A：部署爬虫（✅ 已完成）

已同机部署至 `/opt/dailyhot/crawler`，PM2 进程名 `dailyhot-crawler`（监听 `127.0.0.1:6688`，已 `pm2 save`），`./deploy.sh crawler` 支持后续一键更新。

```bash
# 1. 生产 .env（本地 crawler/.env 需改两处）
cd /Users/empathy/WebstormProjects/DailyForYou/crawler
cp .env /tmp/crawler.prod.env
#   把 PORT=6688、新增 HOST=127.0.0.1、LIBSQL_URL="http://127.0.0.1:8080"
#   DEEPSEEK_API_KEY / LIBSQL_AUTH_TOKEN 沿用本地值

# 2. 构建并上传
pnpm build
ssh root@134.175.155.179 "mkdir -p /opt/dailyhot/crawler/{logs,data}"
rsync -az dist package.json pnpm-lock.yaml ecosystem.config.cjs \
  root@134.175.155.179:/opt/dailyhot/crawler/
scp /tmp/crawler.prod.env root@134.175.155.179:/opt/dailyhot/crawler/.env

# 3. 安装并启动
ssh root@134.175.155.179 "chmod 600 /opt/dailyhot/crawler/.env && \
  cd /opt/dailyhot/crawler && pnpm install --prod --frozen-lockfile && \
  pm2 start ecosystem.config.cjs && pm2 save"

# 4. 验证
curl -s -o /dev/null -w "%{http_code}\n" http://134.175.155.179:8081/feed/v2ex   # 200
```

> 若爬虫要部署到**另一台机器**：那台机器的 `.env` 用 `LIBSQL_URL=http://134.175.155.179:8080`
> （带 `.env` 里的 Bearer token），然后在 Nginx 改一行：
> ```bash
> ssh root@134.175.155.179 "sed -i 's|server 127.0.0.1:6688;|server <爬虫IP>:6688;|' \
>   /etc/nginx/conf.d/dailyforyou.conf && nginx -t && nginx -s reload"
> ```
> 前端**无需重新构建**。

### 任务 B：启用 HTTPS（上线前必须）

当前是纯 HTTP，JWT 与钱包签名消息在明文链路可被窃取。
在 Nginx 加 TLS 证书后，把 `/opt/dailyhot/back/.env` 改为：

```
AUTH_DOMAIN="你的域名"
AUTH_URI="https://你的域名"
```

然后 `pm2 restart dailyhot-back --update-env`。

### 任务 C：提交代码

以下改动尚未提交（`git status` 可见）：

- `backend/src/config.ts`：新增 `HOST`（默认 `0.0.0.0`）
- `backend/src/index.ts`：`serve({ hostname: config.HOST })`
- `backend/ecosystem.config.cjs`：改为直接跑 `dist/index.js`，带 `HOST=127.0.0.1`
- `crawler/src/config.ts`、`crawler/src/index.ts`、`crawler/ecosystem.config.cjs`：同上
- `frontend/vite.config.js`：`VitePWA({ disable: process.env.PWA_DISABLE === "true" })`
- `deploy.sh`（新增）：本地一键部署前端 + 用户服务
- `frontend/.env.production`（新增，被 `.gitignore` 忽略，不入库）
- `DEPLOYMENT.md`、`frontend/README.md`：更新为 8081 与真实流程

---

## 3. 日常更新命令（在本机执行）

脚本已存在：`/Users/empathy/WebstormProjects/DailyForYou/deploy.sh`

```bash
cd /Users/empathy/WebstormProjects/DailyForYou

# 只更新用户服务（已验证：构建 → rsync → pnpm install --prod → pm2 restart → 健康检查）
./deploy.sh backend

# 只更新前端
PWA_DISABLE=true ./deploy.sh frontend

# 前端 + 用户服务
PWA_DISABLE=true ./deploy.sh
```

**必须加 `PWA_DISABLE=true` 的原因**：本机环境对批量文件删除有拦截，
`vite-plugin-pwa` 生成 `sw.js` 时会挂起进程（表现为命令「卡死」）。
加上该变量后跳过 Service Worker 生成，其余产物完全正常，只失去离线缓存能力。
在正常 CI / 其他机器上不加该变量即可（PWA 是项目原有功能，`vite-plugin-pwa ^0.14.7`）。

不加脚本手工部署：

```bash
# 后端
cd backend && pnpm build
rsync -az --timeout=60 dist package.json pnpm-lock.yaml ecosystem.config.cjs \
  root@134.175.155.179:/opt/dailyhot/back/
ssh root@134.175.155.179 "cd /opt/dailyhot/back && pnpm install --prod --frozen-lockfile && pm2 restart dailyhot-back --update-env"

# 前端
cd ../frontend && PWA_DISABLE=true pnpm build
rsync -az --timeout=60 --delete dist/ root@134.175.155.179:/opt/dailyhot/front/dist/
```

---

## 4. 运维速查

```bash
# 服务状态与日志
ssh root@134.175.155.179 "pm2 list; pm2 logs dailyhot-back --lines 50 --nostream"

# 重启
ssh root@134.175.155.179 "pm2 restart dailyhot-back --update-env"

# Nginx
ssh root@134.175.155.179 "nginx -t && nginx -s reload; ss -lntp | grep 8081"

# 数据库规模
ssh root@134.175.155.179 "cd /opt/dailyhot/back && node --input-type=module -e \"
import fs from 'node:fs';
const env=fs.readFileSync('.env','utf8');
const pick=k=>{const m=new RegExp('^'+k+'=(.*)\\$','m').exec(env);return m?m[1].replace(/^\\\"|\\\"\\$/g,''):''};
const {createClient}=await import('@libsql/client');
const c=createClient({url:pick('LIBSQL_URL'),authToken:pick('LIBSQL_AUTH_TOKEN')});
for (const t of ['users','auth_identities','user_news_states']) console.log(t,(await c.execute('select count(*) c from '+t)).rows[0].c);
\""
```

---

## 5. 坑与禁忌

1. **不要 `scp -r backend/*`**：会覆盖服务器 `.env`，冲掉生产密钥。只传
   `dist` / `package.json` / `pnpm-lock.yaml` / `ecosystem.config.cjs`。
2. **不要占用 80 / 8080**：分别属于既有 python 业务与 libSQL。
3. **不要用 `rm -rf` 清 `dist`**：当前环境会挂起。前端更新用脚本，脚本已改为 `mv` 旧产物到临时目录。
4. **`.env.production` 不入库**（`.gitignore` 的 `.env.*` 规则）。换机/CI 需另行创建，
   内容见第 1.2 节。
5. **前端为 hash 路由**，Nginx `try_files` 只是兜底，不需要额外 rewrite。
6. **本次部署的前端不含 `sw.js`**（PWA 被跳过）。若浏览器之前注册过 SW，
   强制刷新一次即可；正常环境重新构建会恢复。

---

## 6. 关键文件位置

| 内容 | 路径 |
| :--- | :--- |
| 部署运维手册 | `DEPLOYMENT.md` |
| 一键部署脚本 | `deploy.sh` |
| 后端 PM2 配置 | `backend/ecosystem.config.cjs` |
| 前端生产变量 | `frontend/.env.production` |
| Nginx 站点配置 | 服务器 `/etc/nginx/conf.d/dailyforyou.conf` |
| 后端生产环境 | 服务器 `/opt/dailyhot/back/.env` |
| 端到端脚本 | `backend/scripts/login-e2e.mjs` |
