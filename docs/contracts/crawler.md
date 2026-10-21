# 爬虫侧契约（crawler）

> 你只依赖数据库，不依赖后端是否活着。你回答两个问题：**系统里有哪些媒体**、**每个媒体最后一次抓到是什么状态**。
> 后端只对你写的表做 `SELECT`，所以**表结构变更就是接口变更**。

---

## 1. 边界

| 项 | 内容 |
| :--- | :--- |
| 拥有 | `news_items`、`sources`、`source_logos`、`schema_meta`、`crawl_runs`；迁移账本 `crawler_migrations` |
| 只读 | 无 |
| 不知道 | 后端、前端、HTTP 接口的存在 |
| 禁止 | 写 backend 的表（`users` / `user_profiles` / `user_news_states`） |

表结构见 [`data-model.md`](./data-model.md)。本文只讲"你该往里写什么、什么时候写"。

---

## 2. 唯一需要维护的清单：`sourceRegistry.ts`

`crawler/src/data/sourceRegistry.ts` 是媒体名的**唯一**出现地。`backend/src` 与 `frontend/src` 下不应 grep 到任何具体媒体名。

```ts
export const SOURCE_REGISTRY: SourceSeed[] = [
  { key: "reuters-world", name: "reuters", subType: "world",
    params: { type: "world" }, adapter: "reuters",
    label: "路透社·国际", category: "财经", type: "国际",
    link: "https://www.reuters.com/world",
    logoText: "路", logoColor: "#E8641B", order: 20, defaultOn: true },
  // ...
];
```

`adapter` 字段是与适配器文件的唯一连线，注册表项必须指向真实存在的 `src/routes/{adapter}.ts`。

---

## 3. 四个交付物

### 3.1 迁移 `c003_sources_registry`

```ts
{
  version: "c003_sources_registry",
  description: "信源清单表（清单 + 抓取状态 + logo 元数据）",
  run: async () => {
    await executeSql(`CREATE TABLE IF NOT EXISTS sources (...)`);        // 见 data-model.md
    await executeSql(`CREATE INDEX IF NOT EXISTS idx_sources_order ON sources(sort_order)`);
    await executeSql(`CREATE TABLE IF NOT EXISTS source_logos (...)`);
    await seedSourcesFromRegistry();   // 直接用 SOURCE_REGISTRY 循环 INSERT
  },
}
```

**为什么 seed 要放在迁移里**：新库第一次跑爬虫时 `sources` 是空的。如果等"抓完第一轮才有清单"，部署完到首轮结束之间前端就是白屏。seed 之后**部署完成的那一刻清单就完整**，只是所有频道显示"暂无数据"。

`source_logos` 只建表、不灌数据——灌二进制要读文件系统，不适合放在迁移里。图片由 `--sync-logos` 单独导入，因此**部署顺序是：迁移 → `--sync-logos` → 重启**。漏了中间这步不报错，只是图标全部退化成文字徽标。

### 3.2 启动对账 `reconcileSources()`

在 `runCrawlerMigrations()` 之后、首轮抓取之前执行。

| 情况 | 动作 |
| :--- | :--- |
| 注册表有、表里没有 | `INSERT`（新源上线） |
| 表里有、注册表没有 | `UPDATE retired = 1`（永不物理删除，保留历史数据） |
| 都有 | `UPDATE` 元数据字段（label / order / params / logo_text / logo_color / logo_url / adapter），**不动状态字段** |

对账同时做一致性校验——这就是为什么不需要构建期校验脚本：

```ts
for (const seed of SOURCE_REGISTRY) {
  if (!fs.existsSync(`routes/${seed.adapter}.ts`) && !fs.existsSync(`routes/${seed.adapter}.js`)) {
    logger.warn(`⚠️ 注册表声明了 ${seed.key}，但适配器 ${seed.adapter} 不存在，已置为 disabled`);
    seed.enabled = 0;   // 不参与抓取，但仍进清单（前端灰显而非静默空白）
  }
}
```

注意是 `enabled = 0` 而不是剔除：源留在清单里，用户能看见"这个频道暂时不可用"，比它凭空消失好。

### 3.3 状态写入时序（心跳协议）

顺序不能乱。每轮抓取**单个源**：

```
① UPDATE sources SET status='running', last_started_at=now WHERE key=?

② 抓取 + 去重 + upsert news_items

③ UPDATE sources SET
     status = CASE WHEN 写入条数>0 THEN 'ok' ELSE 'empty' END,
     last_finished_at = now,
     last_success_at  = CASE WHEN 写入条数>0 THEN now ELSE last_success_at END,
     items_last_run   = ?,
     items_total      = (SELECT COUNT(*) FROM news_items WHERE source_name=? AND sub_type=?),
     consecutive_failures = 0,
     updated_at = now
   WHERE key=?

任一步抛错（catch 内）：
④ UPDATE sources SET status='failed', last_finished_at=now,
     last_error=?, consecutive_failures = consecutive_failures + 1, updated_at=now
   WHERE key=?
```

两个细节：

- **`items_total` 用子查询，不要 `+=` 累加**。Upsert 会更新已有行，累加会越算越虚。
- **`last_success_at` 只在"抓到数据"时更新**。`status='empty'` 不算成功，否则一个连续返回空列表的源会永远显示健康。

### 3.4 `pnpm crawl --sync-logos`

```
crawler/assets/logos/{key}.{png|svg|webp}
        │  pnpm crawl --sync-logos
        ▼
source_logos(key, mime, bytes, width, height, source_file, updated_at)
```

职责：

1. 扫 `crawler/assets/logos/`，文件名去扩展名即 `key`；
2. 校验：`mime` 白名单（png / svg+xml / webp）、单文件 ≤ 256KB、`key` 必须已存在于 `sources`（否则 WARN 跳过，防止孤立图片）；
3. `INSERT OR REPLACE` 写 `source_logos`，同时 `UPDATE sources SET has_logo=1, logo_etag=md5(bytes)`；
4. 对"目录里没有但库里 `has_logo=1`"的**不删除**——换机器部署时目录可能不全，删了就把图丢光。

### 3.5 `pnpm crawl --doctor`（P2）

只读诊断，输出四方对比表：

```
注册表 30 条 / 适配器 43 个 / 库中 49 组 / 图标 32 张
✗ 注册表有、适配器缺失：ngabbs, weibo, zhihu
✗ 适配器存在、注册表未收录（22）：51cto, csdn, hupu, huxiu, ifanr, ...
✗ 库中有数据、清单中无：sina（30 条）
✗ 有图标、清单中无：cls-hot, cls-depth, netease-news
```

这是治理入口，一次把漂移全摊开。

---

## 4. 现存问题：注册表里要先裁决的三类源

| 源 | 情况 | 处置 |
| :--- | :--- | :--- |
| `ngabbs` | 前端 27 个频道里的"NGA"，但 `routes/ngabbs.ts` **不存在**。生产 `/feed/ngabbs` 只有一条 `2026-10-18` 的数据，频道已停两天，没有任何告警 | 补适配器，或 `retired = 1` 从清单移除 |
| `weibo` / `zhihu` | 同上，无适配器，每轮抓取必然失败写错误日志 | 同上 |
| `sina` | 适配器存在、库里 30 条数据，但前端 27 个频道里没有 | 纳入注册表（约等于白捡一个频道） |
| 22 个适配器 | `51cto`、`csdn`、`hupu`、`huxiu`、`ifanr`、`nytimes`、`producthunt`、`smzdm`、`sina-news` 等，完全不在任何清单里 | 逐批纳入或明确放弃 |

图标侧还有 5 张"无主图"要一并裁决：

| 图 | 情况 | 建议 |
| :--- | :--- | :--- |
| `bloomberg.png` / `jin10.png` | 元数据与适配器都有，只是前端没上架 | 纳入注册表当总榜 |
| `cls-hot.png` / `cls-depth.png` | `cls.ts` 的 `handleRoute(_, noCache)` 忽略第一个参数，**不支持子类型** | 删除 |
| `netease-news.png` | 既无适配器也无元数据 | 删除 |

---

## 5. 图标迁移

```
git mv frontend/public/logo crawler/assets/logos
cd crawler && pnpm crawl --sync-logos
```

现有 32 张文件名已经是 `{key}.png`（`reuters-world.png`、`jiemian-hot.png`、`jin10-important.png`），与 `sources.key` 一一对应，**不需要改名**。

搬完并同步进库后 `frontend/public/logo/` 即可删除，但**建议留到前端验收通过再删**，保回滚余地。`deploy.sh` 需要增加上传 `crawler/assets`。

文字徽标的文案与配色在注册表里显式给，没给就按规则推导：

```ts
logoText  ??= label.trim()[0]                       // 取首字
logoColor ??= PALETTE[hash32(key) % PALETTE.length] // 按 key 稳定取色
```

**必须按 `key` 哈希取色，不能随机**——同一个源在任何环境、任何一次启动，徽标颜色都要一致，否则用户会觉得"图标在闪"。

---

## 6. 禁止事项

1. **不要 `DELETE FROM sources`**，用 `retired = 1`。删行会让 `news_items` 的历史数据变成无主记录。
2. **不要写 backend 的表**，即使看起来方便。
3. **不要在 `sources` 里放二进制**，`source_logos` 才是图的地方。
4. **不要跳过 ④ 的失败分支**。没有 `failed` 状态，后端就只能看到"这个源很久没更新"，分不清是没数据还是抓挂了。
5. **不要让 `status` 停在 `running`**。长任务要包 `try/finally`，`finally` 里兜底写 `failed`。

---

## 7. 验收

- [ ] 新库部署后、首轮抓取前，`SELECT COUNT(*) FROM sources` 已经是完整条数（seed 生效）
- [ ] 注册表删掉一个源后重启，该源变为 `retired=1` 且 `news_items` 数据仍可查
- [ ] 注册表声明但适配器缺失时，日志有 WARN，且该源 `enabled=0` 但仍出现在 `/sources`
- [ ] 抓取成功后 `items_total` 与 `SELECT COUNT(*)` 一致（子查询实现正确）
- [ ] 手动 kill 进程后重启，`status` 不会永远停在 `running`
- [ ] `--sync-logos` 跑两次结果一致（幂等），孤立图片只 WARN 不中断
- [ ] `--doctor` 能列出注册表 / 适配器 / 库数据 / 图标四方差异
- [ ] 注册表、适配器、图标三者数量变化时，`schema_meta` 的版本号被正确递增
