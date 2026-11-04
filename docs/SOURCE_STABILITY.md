# 信源爬取难度与稳定性评估

> 评估对象：`crawler/src/routes/` 下 40 个适配器 —— 30 个支撑 38 个已上架频道（reuters ×5、bloomberg ×3、jiemian ×2、jin10 ×2 由同一适配器多频道复用），另 10 个未上架。
> 数据快照：2026-10-29 11:31–11:52 CST（代码审阅 + 生产库查询 + 端点实测）
> 排序口径：**按稳定性从差到好**（第 1 名最差）

---

## 0. 一句话结论

生产链路上**没有"已经挂掉"的信源**，真正的风险不在"抓不到"，而在**"抓到了但悄悄退化"**：

- 最差的一档不是硬失败，而是 **风控挑战页（smzdm）** 与 **翻译污染指纹（路透/彭博/HN，同一 URL 重复入库 2–8 行）**；
- 接入难度最高的一批（签名类：cls / 51cto / bilibili / NGA）反而**运行时最稳**，因为签名一旦算错会当场报错，不会静默；
- 真正会"无声无息变空"的是三类：**HTML 整页扫描（jiemian）**、**GBK + 定制 UA（ngabbs）**、**空返回被判成功（全站通用机制）**；
- 唯一一次真实故障（10-23 夜间 8 条失败）**与适配器质量无关**：全部是境外链路超时，其中 hackernews 连报 DNS 劫持 + TLS 证书不匹配。在中国大陆家宽上，**"境外"比"签名难度"更能预测故障**。

---

## 1. 评估方法

三条独立证据链，避免只凭代码"猜"：

| 证据 | 来源 | 用途 |
| :--- | :--- | :--- |
| 静态审阅 | 40 个适配器 3,041 行 + `getToken/` 3 个签名实现 + `runner.ts` / `translator.ts` / `newsText.ts` | 判定接入方式、解析脆性、契约耦合 |
| 运行时数据 | 生产 libSQL：`crawl_runs` 136 条（10-22 → 10-29）、`news_items` 9,940 行（10-17 → 10-29） | 失败轮次、单轮产出、重复入库、内容新鲜度 |
| 实时探测 | 本机直连各上游端点各 1–4 次，记录状态码与 TTFB（10-29 11:35–11:52） | 当前可达性、风控挑战、超时余量 |

复现方式：

```bash
# ① 生产健康快照（ETag + 60s 缓存，随时可查）
curl -sk https://134.175.155.179:8081/api/sources

# ② 逐源失败与产出（在服务器上走 libSQL HTTP）
#    select source_key, status, items_written, error from crawl_runs order by started_at desc

# ③ 同一 URL 重复入库率（衡量指纹稳定性）
#    select source_name, sub_type, count(*), count(distinct url) from news_items group by 1,2
```

---

## 2. 两个维度不是一回事

| 维度 | 定义 | 取值范围 |
| :--- | :--- | :--- |
| **难度 D** | 从零写出并维护这个适配器要付出的代价：要不要逆向签名、要不要解析 HTML、要不要处理编码/风控 | 1（最容易）→ 5（最难） |
| **稳定性 S** | 无人值守情况下持续产出**正确且不重复**数据的概率 | 1（最差）→ 5（最好） |

判定 S 时的加权顺序：**运行时证据 > 失效是否静默 > 契约强度 > 超时余量**。
高 D 不等于低 S：`cls` 要逆向 `md5(sha1(sorted params))`，但每次签名错误都会立即 4xx，属于"吵闹的失败"，比静默空转安全得多。

### D 分档

| D | 含义 | 典型 |
| :--- | :--- | :--- |
| 1 | 官方 RSS / 公开 JSON API，无鉴权、无特殊头 | nytimes、nodeseek、juejin、v2ex、qq-news |
| 2 | 非文档化内部 API，或需特定 Referer / POST / 境外子域 | 36kr、thepaper、huxiu、geekpark、hupu |
| 3 | HTML 选择器或正则解析 / JSONP 包装 / 静态密钥头 | ithome、github、jiemian、jin10、earthquake |
| 4 | 需逆向签名或先换 token | cls、51cto、bilibili（WBI）、ngabbs |
| 5 | APP 级加密头 / 强风控挑战 | coolapk、producthunt、linuxdo |

### S 分档

| S | 含义 |
| :--- | :--- |
| 5 | 文档化契约（RSS / 长期公开 API），无签名、无风控、无中转、无解析歧义 |
| 4 | 结构化 JSON 或稳定 HTML，偶发 0 产出但有明确原因（去重命中、供给少） |
| 3 | 需签名 / 静态密钥 / HTML 解析 / LLM 中转，**契约一变就静默失效或产生脏数据** |
| 2 | 强风控挑战页，或解析依赖整页结构，任一改版即归零 |
| 1 | 当前实测不可用 |

---

## 3. 主表：38 个已上架频道（稳定性从差到好）

> 表中行数除特别标注外，均为 10-17 → 10-29 的**累计**入库量；"行/URL"= 同 `sub_type` 内 `行数 ÷ 唯一 URL 数`，>1.5 即有实质重复入库；"失败 n/m"= `crawl_runs` 中 `failed` 次数 / 总轮次。

| # | 频道 (key) | 适配器 | D | S | 接入方式 | 主要失效模式 | 实证信号 |
| :--: | :--- | :--- | :--: | :--: | :--- | :--- | :--- |
| 1 | smzdm | smzdm | 2 | 2 | 内部 JSON `/rank/json_more` | 202 + JS 挑战页（`var buid`）替代 JSON，`list.map` 直接抛错；**是否被挑战取决于出口 IP** | 本机 4/4 次均 202 挑战页；同日生产仍入库 30 条 → 同一份代码两种结果 |
| 2 | reuters-technology | reuters | 2 | 3 | Google News RSS + DeepSeek 翻译 | 翻译措辞漂移 → 标题/摘要变 → `news_hash` 变 → 同一条新闻重复入库 | 累计 574 行 / 72 唯一 URL = **7.97 行/URL** |
| 3 | reuters-markets | reuters | 2 | 3 | 同上 | 同上 | 603 行 / 77 URL = **7.83 行/URL** |
| 4 | reuters-business | reuters | 2 | 3 | 同上 | 同上 + `site:` 查询与 latest 高度重叠 | 654 行 / 224 URL = 2.92 |
| 5 | reuters-world | reuters | 2 | 3 | 同上 | 同上 | 657 行 / 245 URL = 2.68 |
| 6 | reuters（要闻） | reuters | 2 | 3 | 同上 | 同上；10-23 出现一次 6000ms 超时整轮失败 | 653 行 / 269 URL = 2.43；失败 1/4 |
| 7 | bloomberg-world | bloomberg | 1 | 3 | Google News RSS（非彭博源站） | 中转 + 翻译漂移；彭博原文付费墙导致摘要质量不稳 | 611 行 / 238 URL = 2.57 |
| 8 | bloomberg-markets | bloomberg | 1 | 3 | 官方 RSS `feeds.bloomberg.com` | 官方 RSS 本身稳（TTFB 1.7s），但单轮仅 18–20 条 | 433 行 / 170 URL = 2.55；单轮 18/20 |
| 9 | bloomberg（资讯） | bloomberg | 1 | 3 | 官方 RSS | 默认关闭；同上 | 187 行 / 122 URL = 1.53 |
| 10 | hackernews | hackernews | 3 | 3 | HTML `tr.athing` + `.titleline` | 解析依赖页面结构；**翻译结果同时进标题与指纹**；无 `pub_time`；链路被污染 | 454 行 / 208 URL = 2.18，454 个标题全不相同 → 纯翻译漂移；10-23 两次失败：`ECONNREFUSED 4.78.139.54:443` + TLS 证书不匹配（见 §7） |
| 11 | jiemian | jiemian | 3 | 3 | 移动站 HTML，**扫描全部 `<a>`** 再用 `/article/(\d+)/` 过滤 | 无任何选择器契约：改版、加频道、换模板都可能全空或混入导航链接 | 8/8 天有产出，30 条/轮；但解析方式是全站最脆 |
| 12 | jiemian-hot | jiemian | 3 | 3 | 同上（`m.jiemian.com/` 首页） | 同上，且与快报共用同一解析器，一坏坏两个 | 238 行，单轮 20 条 |
| 13 | ngabbs | ngabbs | 4 | 3 | `__output=11` 内部输出 + **GBK 解码** + 定制 UA `NGA_WP_JW` | 一旦需登录，返回体里出现「访客不能直接访问」，适配器**跳过该项后返回 0 条** → 记为 `empty`，不告警 | 代码显式处理该字符串（`ngabbs.ts:47`）；7 日 6 天活跃 |
| 14 | douban-group | douban-group | 3 | 3 | HTML `.article .channel-item` | 豆瓣对机房/IP 敏感，403 常态化；选择器依赖列表模板 | 7/8 天活跃，29 条/轮；`pub_time` 含 2001 年脏值 |
| 15 | bilibili | bilibili | 4 | 3 | WBI 签名（`mixinKeyEncTab` 打乱表） | 风控升级 → 主接口空 → 走旧接口降级，**降级后时间戳直接丢失**；`SESSDATA=xxxxxx` 是占位值 | 主接口 30 条/轮；降级路径 `timestamp: undefined` |
| 16 | cls | cls | 4 | 3 | 逆向签名 `md5(sha1(sorted params))` + 硬编码 `sv=8.7.9` | 版本号写死；财联社一旦改签名或改 `sv` 校验 → 全站 403，且报错信息不含原因 | 补签后实测 200 `errno:0`；缺签 200 但返回 39 字节 |
| 17 | 51cto | 51cto | 4 | 3 | 先取 token，再 `md5(md5(path)+md5(params+md5(token)+ts))` | 两跳链路，token 端点一变即全断；签名算法无文档 | token 端点实测 200，token 长度 42 |
| 18 | jin10 | jin10 | 3 | 3 | `flash-api.jin10.com` + 静态头 `x-app-id` | **缺 `x-app-id` 直接 502**（不是 403），排查时容易被误判为"服务端挂了" | 裸 GET → 502/145ms；带头 → 200/114ms |
| 19 | jin10-important | jin10 | 3 | 3 | 同上 + 顺延翻页（最多 8 页） | 重点要闻单页仅 2–3 条，需连翻 8 页；中途任一页失败即 `break`，静默少收 | 单轮 19 条；翻页失败被 `catch{}` 吞掉 |
| 20 | guokr | guokr | 2 | 4 | `guokr.com/beta/proxy/science_api` | 路径里带 `beta`，是内部试验接口，随时可能下线 | 30 条/轮，7 日 5 天活跃 |
| 21 | hellogithub | hellogithub | 2 | 4 | 境外子域 `abroad.hellogithub.com/v1` | 境外线路，实测 TTFB 2.7s（占 6s 预算 45%）；`sort_by` 传错即 400 | 10-23 两次失败：6000ms 超时 + 504；20 条/轮 |
| 22 | ithome | ithome | 3 | 4 | HTML `.rank-box .placeholder` | 选择器绑定 IT之家 排行榜模板；改版即空 | 8/8 天全勤，30 条/轮 |
| 23 | github | github | 3 | 4 | HTML `article.Box-row` + **自建 3 次指数退避** | 唯一自带重试的适配器（20s 超时）；选择器依赖 trending 页结构 | 8/8 天活跃，单轮 14 条 |
| 24 | v2ex | v2ex | 1 | 4 | 公开 `api/topics/hot.json` | 接口只返回 10 条，供给天然稀疏；**接口公开，但境外链路不稳** | 10-23 两次 `6000ms` 超时；单轮 10 条；无 `pub_time` |
| 25 | hupu | hupu | 2 | 4 | `m.hupu.com/api/v2/bbs/topicThreads` | 单轮仅 10 条；无 `pub_time` | 97 行 / 10 条每轮 |
| 26 | newsmth | newsmth | 2 | 4 | `wap.newsmth.net/wap/api/hot/global` | 移动端 API 无契约；`pub_time` 存在 2006 年脏值 | 17–20 条/轮 |
| 27 | sina | sina | 1 | 4 | `newsapp.sina.cn/api/hotlist` | 内部 API；**无 `pub_time`**，前端只能按入库时间排 | 30 条/轮，7 日 5 天活跃 |
| 28 | juejin | juejin | 1 | 4 | 公开 `api.juejin.cn/content_api` | **无 `pub_time`** | 30 条/轮，8/8 天 |
| 29 | huxiu | huxiu | 2 | 4 | `moment-api.huxiu.com/web-v3` + Referer | 需要 Referer，缺则可能 403 | 15–19 条/轮 |
| 30 | ifanr | ifanr | 2 | 4 | `sso.ifanr.com/api/v5/wp/buzz` | 域名语义是个 SSO 域却在当内容 API 用 | 20 条/轮 |
| 31 | sspai | sspai | 1 | 4 | 公开 `sspai.com/api/v1/article/tag/page/get` | 热门文章本身更新慢，7 日仅 13 行；`pub_time` 最新为 10-27 | 6/8 天活跃 |
| 32 | dgtle | dgtle | 2 | 4 | `opser.api.dgtle.com/v2/news/index` | 单轮固定 20 条 | 20 条/轮 |
| 33 | geekpark | geekpark | 2 | 4 | `mainssl.geekpark.net/api/v2` | 子域语义可疑（SSL 入口当 API） | 20 条/轮 |
| 34 | thepaper | thepaper | 2 | 4 | `cache.thepaper.cn/contentapi/wwwIndex/rightSidebar` | 缓存节点接口，字段 `contId` 强耦合 | 20 条/轮 |
| 35 | 36kr | 36kr | 2 | 4 | POST `gateway.36kr.com` + `partner_id` | **必须 POST**（GET → 500）；`templateMaterial` 嵌套结构易改 | 30 条/轮，8/8 天 |
| 36 | qq-news | qq-news | 1 | 5 | 公开 `r.inews.qq.com/gw/event/hot_ranking_list` | `pub_time` 出现 `-62135596800000`（公元 1 年）脏值 | 30 条/轮，8/8 天，TTFB 127ms |
| 37 | nodeseek | nodeseek | 1 | 5 | 官方 RSS `rss.nodeseek.com` | 依赖独立 RSS 子域 | 20 条/轮，TTFB 935ms |
| 38 | nytimes | nytimes | 1 | 5 | 官方 RSS `cn.nytimes.com/rss/` | 只有 RSS 摘要，正文需二次抓取（当前不做） | 20 条/轮，TTFB 1.0s |

---

## 4. 未上架的 10 个适配器

不在 `sources` 清单里，因此不参与排序；但它们决定了"这 3,000 行代码里有多少是死重"。

| 适配器 | D | 实测状态（10-29 11:40） | 结论 |
| :--- | :--: | :--- | :--- |
| earthquake | 3 | **405** `{"code":"40510001","msg":"invisible bucket"}` | 上游已改，正则 `const newdata = [...]` 同时失效 → 双重不可用 |
| linuxdo | 4 | **403** Cloudflare `Just a moment...` | 需要 JS 挑战/Cookie，当前 Node 侧无法通过 |
| producthunt | 5 | **403** Cloudflare `Just a moment...` | 且解析用 `[data-test=...]` 测试属性，最易改 |
| coolapk | 5 | 未验证（需 APP 加密头） | 硬编码 appCode/appVersion，随 APP 升级失效 |
| sina-news | 3 | 200（可用） | 但硬校验 `var data = ` 前缀 + 依赖当日 `top_time`，改造价值低 |
| weatheralarm | 1 | 200（明文 HTTP） | 可用但走 `http://`，建议改 https 或退回 |
| history | 2 | 200（百度百科月度 JSON） | 可用，内容为历史事件，非时效新闻 |
| ithome-xijiayi | 3 | 200 | 可用，HTML `.newslist li` |
| 52pojie | 1 | 200（Discuz RSS） | 可用，纯 RSS |
| hostloc | 1 | 200（Discuz RSS，1.1s） | 可用，纯 RSS |

> 附带发现：`sources` 表里还有一条 `douyin`（`retired=1`，`items_total=329`）——适配器文件已不存在，属于历史残留；`reconcileSources()` 只同步注册表内条目，不会清理它。

---

## 5. 分档解读

### S=2｜风控型：结果取决于出口 IP
`smzdm` 是唯一一个"代码没问题、环境决定成败"的源。同一份适配器，本机 4 次请求全部拿到 202 挑战页，而生产 02:22 那轮照样入库 30 条。
**这类源不能靠"有没有报错"判断健康**：命中挑战页时它确实会失败，但 `last_error` 里只会留下 `Cannot read properties of undefined (reading 'map')`——看到这行的人很难立刻想到"被风控了"。

### S=3｜签名型 + 解析型 + 翻译型（18 个，占 47%）
这一档内部差别很大，排序依据是"失效后果"：

- **脏数据（最危险）**：reuters ×5、bloomberg ×3、hackernews。翻译结果进了 `news_hash`（`newsText.ts:54`，hash = md5(来源+标题+摘要)），而 `temperature: 0.1` 仍会让同一句话每轮译得不一样 → 新 hash → 新行。实测 `reuters-technology` 每条 URL 平均 8 行。
- **静默空转**：jiemian ×2（全页 `<a>` 扫描）、ngabbs（「访客不能直接访问」直接 `continue`）、douban-group（反爬）。三者都会"成功返回 0 条"，然后被记成 `empty`——而库里目前 **0 条 `empty` 记录**，说明这条分支从未被真正验证过。
- **吵闹的失败（相对安全）**：cls、51cto、jin10 ×2、bilibili。签名/密钥错会立刻 4xx/502，`last_error` 有内容，人工能看到。

### S=4｜结构化但非契约（16 个）
JSON 字段直接取值，最多是内部 API 改字段；需要解析 HTML 的只有 ithome、github 两个，都有明确选择器且 8 天全勤。
共同短板是**没有重试**：`REQUEST_TIMEOUT=6000`，一旦首包抖动就整轮失败。

### S=5｜文档化契约（3 个）
`qq-news`、`nodeseek`、`nytimes` 的共同点：要么是官方 RSS，要么是十年不变的公开榜单接口，且 TTFB 都在 1s 内。唯一问题是 `qq-news` 的时间戳脏值。

---

## 6. 六个系统性风险（都在平台层，不在单个适配器里）

| # | 风险 | 位置 | 后果 |
| :--: | :--- | :--- | :--- |
| 1 | **空返回不算失败** | `sourcesRepo.ts:280`：`status = written>0 ? 'ok' : 'empty'`，且 `consecutive_failures=0`、`last_success_at` 不更新 | 静默空转不会自动下架（下架阈值是连续 5 次 `failed`）。只有 4h 后 `stale=true` 能间接暴露（`newsDb.ts:260`，2×间隔）。该分支至今 0 次触发，属未验证灰区 |
| 2 | **翻译污染指纹** | `reuters/bloomberg/hackernews` → `translateTexts` → `buildNewsText`（`newsText.ts:54`） | 9 个频道持续重复入库；`reuters-technology` 8 行/URL |
| 3 | **6s 超时 + 零重试** | `config.ts:49`（`REQUEST_TIMEOUT=6000`）、`runner.ts:86` | 境外源实测 TTFB：hellogithub 2.7s、bloomberg 1.7s、github 1.4s、google-rss 1.5s，余量仅 2–4s；只有 github 自带退避重试 |
| 4 | **单一中转** | `reuters.ts:48`、`bloomberg.ts:18-19` | 5 个路透频道 + 2 个彭博频道全部走 `news.google.com/rss/search`，只换 `site:` 查询；Google 侧限流或结果重叠会同时影响 7 个频道，而且 `latest` 与 `world/business` 结果高度重复 |
| 5 | **单轮 30 条上限** | `runner.ts:95`（`maxItems: 30`） | 单频道日上限 = 12 轮 × 30 = 360 条；`cls`（7 日 116 行）、`smzdm`、`qq-news` 这类高频源会持续丢弃尾部 |
| 6 | **7 个频道没有 `pub_time`** | github、hackernews、hupu、jiemian、juejin、sina、v2ex | 前端无法按内容时间排序，也无法做"内容新鲜度"告警，只能退回 `created_at` |

补充：`crawl_runs` 的 `run_id` 是**每信源一个**（136 行 = 136 个源级任务），不是"整轮一个 ID"，所以现在没法回答"这一轮整体耗时/整体成败"。

---

## 7. 唯一一次有记录的批量失败：境外链路，不是适配器

136 条源级任务里 `ok` 128、`failed` 8（5.9%），**8 条全部落在 2026-10-23 00:58 这一分钟内**，且全部是境外源：

| 信源 | 错误原文 | 判读 |
| :--- | :--- | :--- |
| hellogithub | `timeout of 6000ms exceeded` | 2.7s 的常态 TTFB，夜间链路抖动即超 6s |
| hellogithub | `Request failed with status code 504` | 上游/中间节点 504 |
| v2ex | `timeout of 6000ms exceeded` ×2 | 两次都是超时，指向链路而非接口 |
| reuters / reuters-world | `timeout of 6000ms exceeded` | Google News RSS 夜间变慢 |
| hackernews | `connect ECONNREFUSED 4.78.139.54:443` | DNS 被解析到无关 IP |
| hackernews | `Hostname/IP does not match certificate's altnames: Host: news.ycombinator.com is not in the cert's altnames: DNS:app.mhradio.org` | **TLS 被中间人替换**，证书属于无关站点 |

两条 hackernews 错误合起来是一次典型的 DNS 污染/劫持：域名被指到一个无关主机，证书校验随即失败。
这类失败**与适配器质量无关**——v2ex 的适配器是全项目最简单的 RSS/JSON 之一（D=1），照样连挂两轮。它也解释了为什么"境内外分档"比"签名难度"更能预测故障：真正决定 S 的，是这条链路在中国大陆家宽上稳不稳。

值得注意的是：这批失败发生在 **00:58（凌晨）**，而 10-22、10-29 的 02:22 轮次全部成功。若抓取固定在这个时段，遇到链路维护窗口的概率会被放大。

---

## 8. 改进优先级

> 本表的落地设计（含数据迁移、验收口径、回滚方式）见 `docs/design/content-supply-optimization.md`；下表是"问题清单"，那份是"施工图"，两者不一致时以设计稿为准。

| 优先级 | 动作 | 落点 | 预期收益 |
| :--- | :--- | :--- | :--- |
| **P0** | 指纹改用**翻译前**的原始标题+URL（或 `guid`） | `newsText.ts` 增加 `rawTitle`/`sourceKey` 入参，三个翻译适配器传入原文 | 直接消掉 2/3/4/10 名的重复入库（约 -60% 行数） |
| **P0** | `smzdm` 增加"响应体非 JSON"判定，命中挑战页时抛明确错误 | `smzdm.ts:52` 前加 `Array.isArray(result.data?.data)` 校验 | 从"`TypeError: list.map`"变成可读的失败原因 |
| **P1** | `REQUEST_TIMEOUT` 按信源分级（境外 15s，境内 6s） | `getData.ts` 允许 `options.timeout` 覆盖；先把 `reuters/bloomberg/nytimes/github/hellogithub/hostloc` 提上去 | 消除超时余量 < 50% 的抖动 |
| **P1** | `empty` 连续 N 次升级为 `failed` | `sourcesRepo.ts:280` 增 `consecutive_empty` 计数 | 让 ngabbs / jiemian 这类静默空转进入告警 |
| **P1** | 缺失 `pub_time` 的 7 个适配器补时间（能从列表页拿就拿，拿不到用 `created_at` 并标记） | 各适配器 map 段 | 恢复前端时间排序 + 新鲜度监控 |
| **P2** | 给 reuters/bloomberg 增加"同 URL 已存在则跳过"的入库前置判断 | `newsRepo.ts` upsert 前按 `url` 查一次 | 兜住翻译漂移的剩余部分 |
| **P2** | 清理 `earthquake` / `linuxdo` / `producthunt` / `coolapk` / `douyin` 死代码与残留行 | `routes/` + `sources` | 减少 `--doctor` 噪音 |
| **P2** | `crawl_runs` 增加 batch 级 `batch_id`，记录整轮起止 | `runner.ts` | 才能回答"这一轮跑完没有" |

---

## 附录 A：实时探测记录（2026-10-29 11:35–11:52 CST）

| 结果 | 信道 |
| :--- | :--- |
| 200 且内容正确 | 36kr(POST)、sspai、ithome、thepaper、juejin、qq-news、jiemian、douban-group、ngabbs、github、v2ex、hackernews、jin10(带 `x-app-id`)、google-news-rss、bloomberg、nytimes、sina、nodeseek、newsmth、huxiu、ifanr、guokr、geekpark、51cto(token)、dgtle、hupu、52pojie、hostloc、hellogithub(带正确 `sort_by`)、weatheralarm、history、ithome-xijiayi、sina-news |
| 200 但需签名/配额才有效 | cls（未签名返回 39 字节；补签后 `errno:0`）、bilibili（未带 WBI 也返回 200，必须靠 `data.list` 非空判定） |
| 202（挑战页） | smzdm（4/4 次） |
| 403（Cloudflare） | linuxdo、producthunt |
| 405（上游已改） | earthquake |
| 502（缺静态头，非宕机） | jin10（裸 GET） |
| 4xx/5xx 因调用方式不符 | 36kr（GET → 500） |

响应耗时（TTFB，用于判断 6s 余量）：qq-news 127ms、jin10 114ms、cls 120ms、36kr 468ms、51cto 181ms、nodeseek 935ms、google-rss 946ms、nytimes 1.0s、hostloc 1.1s、github 1.4s、hackernews 1.5s、bloomberg-feeds 1.7s、hellogithub 2.7s。

## 附录 B：运行时数据摘要（2026-10-17 → 10-29）

- `news_items` 9,940 行 / 35 个 `source_name` / 12 天。
- `crawl_runs` 136 条源级任务：`ok` 128、`failed` 8、**`empty` 0**；失败仅集中在 10-23 00:58 一轮（详见 §7）。
- 失败分布：hackernews 2、hellogithub 2、v2ex 2、reuters 1、reuters-world 1。
- 7 日入库最多：reuters 562、bloomberg 286、jiemian 181、jin10 133、sina 119。
- 7 日入库最少：sspai 13、ifanr 15、hellogithub 19、dgtle 20、github 21。
- 单轮产出触顶 30 条（说明被 `maxItems` 截断）的频道：36kr、51cto、bilibili、guokr、ithome、juejin、ngabbs、qq-news、reuters ×5、bloomberg-world、sina、smzdm、sspai。
- 已停止更新（非故障，系下架）：history（10-21）、ithome-xijiayi（10-20）、sina-news（10-21）、weatheralarm（10-21）。
