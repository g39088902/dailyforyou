# 后端侧契约（backend）

> 你只做两件事：把爬虫写进库的事实**翻译成 API**，把用户数据管好。
> 清单不归你维护——`SELECT sources` 就是了。

---

## 1. 边界

| 项 | 内容 |
| :--- | :--- |
| 拥有 | `users`、`auth_*`、`user_profiles`、`user_news_states`；迁移账本 `user_migrations` |
| 只读 | `news_items`、`sources`、`source_logos`、`schema_meta`、`crawl_runs` |
| 不拥有 | 媒体清单、抓取状态、图标二进制——这些是爬虫的事实，你只负责转发 |
| 禁止 | 对爬虫的表执行 `INSERT` / `UPDATE` / `DELETE`；在 `src` 里嵌入媒体名 |

**代码收口**：`backend/src/utils/newsDb.ts` 是唯一允许出现 `news_items` / `sources` 表名的文件。其他文件要清单就调它。

表结构见 [`data-model.md`](./data-model.md)。

---

## 2. `GET /sources` — 清单 + 状态

读 `sources` 表（`retired = 0`），把 `params_json` 解析成对象返回。静态元数据与运行时状态在**同一行**里，一次查询搞定。

```jsonc
{
  "code": 200,
  "initialized": true,               // false = 表不存在/为空，前端显示初始化中
  "etag": "src-8f3a1c",
  "generatedAt": "2026-10-20T16:40:00.000Z",
  "sources": [
    {
      "key": "reuters-world",
      "name": "reuters",
      "params": { "type": "world" },
      "label": "路透社·国际",
      "category": "财经",
      "type": "国际",
      "link": "https://www.reuters.com/world",
      "logo": "/logo/reuters-world.png",   // 相对路径，前端拼 FEED_BASE_URL
      "logoText": "路",                    // 文字徽标兜底（离线也能画）
      "logoColor": "#E8641B",
      "order": 20,
      "defaultOn": true,
      "enabled": true,
      "stats": {
        "total": 424,
        "lastSuccessAt": "2026-10-20T08:21:36.530Z",
        "stale": false,
        "status": "ok",
        "consecutiveFailures": 0
      }
    }
  ]
}
```

字段规则：

- **`enabled`** = `enabled = 1 AND retired = 0 AND consecutive_failures < 5`。连续失败 5 次自动判不可用，但**不从清单里消失**——前端灰显而不是隐藏，让"某个源挂了"这件事可见。
- **`stale`** = `now - last_success_at > 2 × CRAWL_INTERVAL_MINUTES`（默认 120 分钟，阈值 4 小时）。
- **`status`**：读库时若 `status='running'` 且 `last_started_at` 超过 30 分钟，对外报 `stuck`（等价 `failed`）。这是防止进程被 kill 后残留的"永远抓取中"。
- **`logo`**：`logo_url` 有值就用它，否则 `/logo/{key}.png`。**该字段永远非空**，因为 `/logo/{key}.png` 有兜底徽标。
- **`ETag`** = `md5(MAX(updated_at) + COUNT(*))`。客户端带 `If-None-Match` 直接返回 `304`。清单一天最多变一次，没必要每次全量传。

**缓存**：60 秒进程内缓存（沿用 `promptDb.ts` 已有的模式），避免每次请求都打库。`/logo` 共用同一份 TTL，换图后最多 60 秒生效，够用。

**排序**：按 `sort_order ASC, key ASC`。不要按 `label` 排，中文排序在不同 collation 下不一致。

---

## 3. `GET /logo/:file` — 永远有图的图标

```
GET /logo/reuters-world.png
```

注册在 `newsRouter` 内、`/:source` **之前**。`/logo/x.png` 是两段路径，理论上不会命中单段通配，但顺序仍要显式保证。

处理顺序：

```
1. 解析 file → key（去扩展名）+ ext
2. key 不在 sources（或 retired = 1）→ 404      ← 防止任意字符串都生成图
3. logo_url 非空            → 302 跳转
4. source_logos 命中        → 200 + bytes
5. 否则                     → 200 + 动态 SVG 文字徽标
```

第 2 步是必要的守门：不做这层校验，任意字符串都能让后端生成图片，等于开放了一个无成本的资源消耗口。

响应头：

| 头 | 值 | 理由 |
| :--- | :--- | :--- |
| `Content-Type` | blob 用其 `mime`；生成图用 `image/svg+xml` | |
| `ETag` | `logo_etag`，生成图用 `md5(text+color)` | 内容变了浏览器才重取 |
| `Cache-Control` | `public, max-age=604800` | 图标一周一变都算频繁 |
| `X-Logo-Source` | `url` / `blob` / `badge` | 排障时一眼看出走了哪一级 |

**带扩展名是刻意的**：`/logo/reuters-world.png` 能命中 PWA 已有的 workbox 规则（`urlPattern: /(.*?)\.(webp|png|jpe?g|svg)/`），也会被任何 CDN / 反向代理当成图片处理；不带扩展名的 `/logo/reuters-world` 两者都不认。

文字徽标生成（约十行，无第三方依赖）：

```ts
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="${color}"/>
  <text x="32" y="34" text-anchor="middle" font-family="sans-serif" font-size="28" fill="#fff">${esc(text)}</text>
</svg>`;
```

**必须转义**：`label` 里可能出现 `&`（如 "AT&T"），不转义就是非法 XML，浏览器直接白图。

**性能**：启动时把 `source_logos` 全表读进内存 Map（`key → { mime, bytes, etag }`），`/logo` 退化成纯内存操作。50 个源、总共约 1.5MB，常驻完全可接受；而每次都走远程 libSQL 要 3–8ms，且 `/logo` 是图片请求，量比 JSON 接口大得多。

---

## 4. `GET /health`

`deploy.sh` 现在只断言单信源接口返回 200，但**爬虫死了它照样 200**。补一个真正有信息量的端点：

```jsonc
{
  "code": 200,
  "status": "ok",                  // ok | degraded | down
  "db": { "ok": true, "latencyMs": 3 },
  "sources": { "total": 27, "stale": 2, "failed": 0 },
  "crawler": { "lastStartedAt": "2026-10-20T08:25:00.000Z", "lagMinutes": 23 },
  "schema": { "expected": 3, "actual": 3 }
}
```

判定：

- `lagMinutes > 2 × CRAWL_INTERVAL_MINUTES` → `degraded`
- `lagMinutes > 6 ×` → `down`
- `schema.expected !== schema.actual` → 至少 `degraded`

`deploy.sh` 的 `health_check()` 改为：

```bash
health=$(curl -s -m 10 "$SITE/api/health")
echo "$health" | grep -q '"status":"ok"' || fail "服务降级：$health"
```

心跳走数据库而不是 HTTP 探活是有意的：crawler 挂掉时，库里的最后一条记录就是证据，后端照样读得到；反过来做探活会让 backend 依赖爬虫的可用性，形成反向耦合。

---

## 5. 数据接口保持兼容

```
GET /{name}?type={subType}&limit=30
```

语义不变：`source_name = name AND sub_type = params.type`。前端从清单拿到 `name` 和 `params` 直接拼，不再需要 `getHotLists` 的前缀白名单。

响应补一个 `key` 字段，避免前端拿 `name` 回查时对不上子类型：

```jsonc
{ "code": 200, "key": "reuters-world", "name": "reuters", "total": 30, "data": [...] }
```

---

## 6. 错误语义

| 场景 | 现在 | 改后 |
| :--- | :--- | :--- |
| 未知信源 | `200 + data: []` | `404 { code: 404, message: "unknown source" }` |
| 清单内但无数据 | `200 + data: []` | `200 + data: []`（正常，新源刚上线） |
| 清单内但已 stale | `200 + data: []` 或旧数据 | `200` + `stale: true`，前端标记"数据可能滞后" |
| `sources` 表不存在 | — | `/sources` 返回 `200 + initialized: false + sources: []`，不 500 |
| 爬虫停摆 | 完全无感 | `/health` 报 `lagMinutes`，`/sources` 全量 `stale: true` |

**未知信源返回 404 是必要的一刀。** 它对不存在的名字一律返回 200 空数组，让"前端写了后端不认识的名字"变成了一个永远空白、不报错、不告警的频道——这就是现网 NGA 频道停了两天没人发现的原因。

**`sources` 表不存在的容错同样重要**：backend 可能先于 crawler 部署，或连到一个刚建好的空库。此时 `SELECT FROM sources` 会抛 `no such table`，必须捕获并返回 `initialized: false`，不能 500。同理 `/logo/:file` 在表缺失时应直接走第 5 步的文字徽标（如果有 `sources` 元数据）或 404。

---

## 7. 禁止事项

1. **不要维护第二份清单**。删掉 `SOURCE_METADATA_MAP` 里的媒体名，改为查 `sources` 表。留一份兜底常量就又是一份会漂移的真相。
2. **不要写爬虫的表**，即使只是"顺手更新一下 last_success_at"。
3. **不要在 `/sources` 响应里塞二进制**，也不要在 `SELECT` 里带 `source_logos.bytes`。
4. **不要对未知信源返回 200 空数组**，那是在制造沉默失败。
5. **不要在 `/logo` 里做同步图片处理**（缩放、转码）。要压缩就在入库前做，请求路径只做搬运。

---

## 8. 验收

- [ ] `curl /api/sources` 返回完整清单，每条带 `stats` 与 `logo`
- [ ] `curl -I /api/sources` 带 `ETag`，二次请求 `If-None-Match` 返回 `304`
- [ ] `/sources` 响应体不含二进制；`SELECT` 不触碰 `source_logos.bytes`
- [ ] `curl -I /api/logo/reuters-world.png` 返回 200 且 `X-Logo-Source: blob`
- [ ] 删掉某源的 `source_logos` 行后，该图返回 200 + `image/svg+xml` + `X-Logo-Source: badge`
- [ ] `curl -I /api/logo/不存在.png` 返回 404
- [ ] `curl /api/health` 能看出爬虫最近一次抓取时间
- [ ] `pm2 stop dailyhot-crawler` 后 5 分钟内 `/api/health` 变 `degraded`
- [ ] 空库（无 `sources` 表）下 `/sources` 返回 `200 + initialized: false`，不 500
- [ ] 未知信源返回 `404`，不再静默空数组
- [ ] `backend/src` 下 grep 不到任何具体媒体名
