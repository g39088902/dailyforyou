# 三层契约（已按服务拆分）

本文档已拆成四份，按角色阅读，避免前端开发者被迫读爬虫的表时序：

| 文档 | 谁看 | 内容 |
| :--- | :--- | :--- |
| [`contracts/README.md`](contracts/README.md) | 所有人（先看这页） | 结论、依赖方向、现状诊断、发布顺序、分期归属、全局验收 |
| [`contracts/data-model.md`](contracts/data-model.md) | 改表的人 | `sources` / `source_logos` / `schema_meta` / `crawl_runs` 的表结构与字段语义（唯一副本） |
| [`contracts/crawler.md`](contracts/crawler.md) | 爬虫 | 注册表、启动对账、状态写入时序、`--sync-logos`、`--doctor` |
| [`contracts/backend.md`](contracts/backend.md) | 后端 | `/sources`、`/logo/:file`、`/health`、错误语义、缓存与容错 |
| [`contracts/frontend.md`](contracts/frontend.md) | 前端 | 要删的四份清单、状态模型、两级降级、图标用法 |

拆分原则：

- **表结构只写一次**（`data-model.md`），另外两份引用而不复制，避免 schema 漂移；
- **接口规格只写一次**（`backend.md`），前端只写"怎么消费、怎么降级"；
- **任务与验收跟着负责人走**，不集中在总览页。
