# notes/ 索引

归属规则：每个主题只住一份笔记，PLAN.md 只放结论加路径。改决策先改 PLAN 第 5 节对应行，旧结论进 decisions-log.md。过程记录进 history/，只读。`private-` 前缀不入库。

## 主题笔记（当前态，随决策更新）

| 文件 | 内容 | 公开 |
|---|---|---|
| jev-api.md | Jev 接口硬事实、token 估算、三条接入路径请求形状、错误码、法务 | 可以 |
| jev-question-writing.md | 写题规则、cookbook 先例、v3 题库 | 可以 |
| brave-llm-context.md | Brave LLM Context API 参数、响应形状、计费、上游服务器结构 | 可以 |
| local-rules-design.md | 本地规则层：JSON-LD 分流、URL 归并、预筛、黑名单、裁回预算、状态行 | 可以 |
| dedup-and-rewrite-policy.md | 重复与转述稿：片段级增量新颖度、播种顺序、论证段保护 | 可以 |
| non-article-pages.md | 列表页 / feed / 付费墙 / 元数据页的识别与处理、标记列表 | 可以 |
| staleness.md | 版本过时与自称废弃：intent 点名、两道题、风险缓解 | 可以 |
| labeling-rubric.md | 影子期人工标注尺子与 12 源黄金样本 | 可以 |
| shadow-mode-logging.md | 三档模式、兜底、超限阶梯、日志格式、审核流程、阈值初值 | 可以 |
| decisions-log.md | 决策变更日志 | 可以 |
| status.md | 进度、卡点、待办、文件地图；每次会话先读 | 可以 |

## 私有（gitignore）

| 文件 | 内容 |
|---|---|
| private-jev-evidence.md | 官方自报、社区实测、本机探测的全部 Jev 数字（MCA 2.3(f)） |
| private-local-env.md | 本机 key 变量名、代理、配置路径、补丁脚本、临时目录 |

## history/（按日期归档，只读）

| 文件 | 内容 |
|---|---|
| 2026-09-19-investigation.md | PLAN v2 第 10–12 节：联网调查、据此修订的设计、四项拍板 |
| 2026-09-19-sample-review.md | PLAN v2 第 9、13 节：12 源手工复盘、拿 key 后复核、Sanity 试跑 |
| 2026-09-19-lessons-fast-jev-compaction.md | 从 Jev 压缩插件借鉴的工程做法与函数钩子路线比较 |
