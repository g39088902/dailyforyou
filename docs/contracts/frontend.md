# 前端侧契约（frontend）

> 你不持有"系统里有哪些媒体"这份知识。你只持有"这个用户想看哪些、按什么顺序"。
> 清单和图标都由后端下发，你负责渲染、合并和降级。

---

## 1. 边界

| 项 | 内容 |
| :--- | :--- |
| 拥有 | 用户偏好（开关、排序）、上次成功的清单快照、已读集合 |
| 依赖 | `GET /sources` 拿清单，`GET /{name}?type={subType}` 拿列表，`GET /logo/{key}.png` 拿图标 |
| 不知道 | 爬虫、数据库、`source_name` / `sub_type` 的存储细节 |
| 禁止 | 在 `src` 里写死任何媒体名、路径前缀规则、图标文件名 |

---

## 2. 要删掉的东西

这次改造的主体是**减法**。四个位置、四份清单，全部交给 `/sources`：

| 文件 | 删除内容 | 替代 |
| :--- | :--- | :--- |
| `src/store/index.js` | `defaultNewsArr`（27 个频道）、`newsArr`、`checkNewsUpdate` 的 merge 逻辑 | `/sources` 响应 |
| `src/api/index.js` | `getHotLists` 的 `cls-` / `jiemian-` / `reuters-` / `jin10-` / `bloomberg-` 五个前缀白名单 | 清单里的 `name` + `params` |
| `src/components/Stream/StreamSourceNav.vue` | `@error` 静默隐藏图标的逻辑 | 后端保证永不 404 |
| `public/logo/` | 32 张 png | `GET /logo/{key}.png` |

`getHotLists` 那一处现在最容易出事：它把 `jiemian-hot` 映射成 `/jiemian`、`reuters-world` 映射成 `/reuters`，靠字符串前缀猜测。**新增一个带子类型的信源（比如 `ft-markets`）时，如果不改这里，请求直接 404。** 改成读清单里的 `name` + `params` 之后，这个问题从根上消失。

`checkNewsUpdate` 的 merge 逻辑（保留用户 `show`/`order`，用新默认值覆盖 `label`/`params`，补新增、删下线）本质是"手工模拟一次服务端下发"。现在有真的下发了，这套逻辑可以整段删除。

---

## 3. 请求拼装

```js
// 列表
const src = sources.find(s => s.key === key);
await api.get(`/${src.name}`, { params: { ...src.params, limit: 30 } });
// → GET /reuters?type=world&limit=30

// 图标（相对路径，需拼 baseURL）
const src_url = `${FEED_BASE_URL}${src.logo}`;
```

`src.params` 直接展开，不做任何字符串变形。`src.key` 只用于 React/Vue 的 key、`localStorage` 和已读集合，**不参与 URL 拼接**。

图片统一写成：

```html
<img :src="FEED_BASE_URL + source.logo" :alt="source.label" />
```

**不要加 `@error` 隐藏**。后端三级 fallback 保证任何源都有图，`@error` 只会掩盖真正的问题。

---

## 4. 状态模型

```js
// 持久化：只有个人偏好 + 上次成功的清单快照
{
  "sourcePrefs":     { "reuters-world": { "show": true, "order": 20 } },
  "sourcesSnapshot": { "etag": "src-8f3a1c", "sources": [ /* ... */ ] }
}

// 内存：运行时合并
sources = snapshot.sources
  .map(s => ({ ...s, show: prefs[s.key]?.show ?? s.defaultOn, order: prefs[s.key]?.order ?? s.order }))
  .sort((a, b) => a.order - b.order);
```

`key` 就是现在 UI 里的 `jiemian-hot`，所以**老用户的 `localStorage` 无需迁移**——这一点在改字段名时最容易破坏，务必保留。

`localStorage` 键名建议：`sourcePrefs`、`sourcesSnapshot`（与现状的 `newsArr` 分开，避免读到旧结构）。

---

## 5. 降级策略（两级）

| 情况 | 行为 |
| :--- | :--- |
| `/sources` 正常 | 用响应，覆盖 snapshot |
| `/sources` 失败，有 snapshot | 用 snapshot，后台指数退避重试，顶部提示"清单可能不是最新" |
| `/sources` 失败，无 snapshot（首次访问即断网 / 后端全挂） | 空态页："正在初始化，请稍后重试" + 重试按钮 |

**刻意不给前端内置兜底清单。** 一旦内置，就又是一份会漂移的真相——这正是这次要消灭的东西。首次断网的极端场景用空态页接住，代价明确、可接受。

另外要处理 `initialized: false`：后端返回了 200 但表是空的（新环境刚部署）。此时也走空态页，但文案是"正在初始化"，而不是"加载失败"。

---

## 6. 错误处理

后端改了错误语义（详见 [`backend.md`](./backend.md) 第 6 节），前端要跟上：

| 场景 | 前端行为 |
| :--- | :--- |
| `404 unknown source` | 该频道显示"信源已下线"，并**把它从本地列表移除**——这通常是清单里残留了后端不认识的名字 |
| `200 + data: []` | 正常空态："暂无数据" |
| `stats.stale: true` | 频道标题旁加"数据可能滞后"标记（P2，可先只记日志） |
| `enabled: false` | 频道灰显，不可点击，hover 提示"该信源暂不可用" |
| `/sources` 返回 `initialized: false` | 空态页，文案"正在初始化" |

`404` 从"静默空频道"变成明确的错误信号，这是这次改造最直接的收益之一。

---

## 7. 改动清单（按文件）

| 文件 | 改什么 |
| :--- | :--- |
| `src/api/index.js` | 删 `getHotLists` 前缀映射；加 `getSources()`；列表请求改为接受 `{ name, params }` |
| `src/store/index.js` | 删 `defaultNewsArr` / `newsArr` / `checkNewsUpdate`；加 `sources` / `loadSources()` / `setPref()` |
| `src/components/Stream/composables/useStreamSources.js` | 不再遍历固定数组（`loadAllSourcesSequentially`），改为遍历 `store.sources` |
| `src/components/Stream/StreamSourceNav.vue` | 图标改用 `FEED_BASE_URL + source.logo`，删 `@error` 隐藏 |
| `src/views/Setting.vue` | 信源开关列表改为动态渲染，图标同上；补灰显状态 |
| `src/views/Stream.vue` | 空态与错误态分支 |

新增文件建议 `src/store/sources.js`，把"拉清单 + 合并偏好 + 降级"独立出来，避免把 `store/index.js` 撑大。

---

## 8. 禁止事项

1. **不要在代码里写任何媒体名**。包括数组、对象键、`if (name === "reuters")`、常量文件。
2. **不要写路径前缀规则**。`name` 和 `params` 从清单来，不需要你推断。
3. **不要兜底一份内置清单**，哪怕是"只有几个常见的"。
4. **不要手拼 `/logo/{name}.png`**，一律用后端给的 `source.logo`。
5. **不要静默吞掉 404**。它是唯一能告诉你"清单与后端不一致"的信号。

---

## 9. 验收

- [ ] `frontend/src` 下 grep 不到任何具体媒体名（`reuters`、`jiemian`、`jin10`…）
- [ ] `frontend/public/logo/` 已删除，全站图标请求都指向 `/logo/{key}.png`
- [ ] 新增一个媒体（改 `sourceRegistry.ts` + 加适配器）后，前端**零改动**即可显示，含图标
- [ ] 清空 `localStorage` 后首屏正常；只有 `sourcePrefs` 没有 snapshot 时也正常
- [ ] 断网首次访问显示"正在初始化"空态，不白屏、不报错
- [ ] `/sources` 返回 `initialized: false` 时走空态页
- [ ] 故意让某个源返回 404，前端提示"信源已下线"并移除，而不是留一个空频道
- [ ] 老用户的开关与排序在升级后保持不变
