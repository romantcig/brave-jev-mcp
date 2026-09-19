# notes/ 索引

PLAN.md 是决策记录；这里放可复用的事实与经验，按主题拆分，随调查更新。

| 文件 | 内容 | 能否随仓库公开 |
|---|---|---|
| jev-api.md | Jev 接口硬事实、三条接入路径的精确请求形状、错误码、限额 | 可以 |
| jev-question-writing.md | 怎么给 Jev 写题：官方规则、cookbook 先例、我们的题库草案 | 可以 |
| brave-llm-context.md | Brave LLM Context API 的参数语义、响应形状、计费、上游服务器结构 | 可以 |
| local-rules-design.md | 本地规则层八步设计与夹具观察 | 可以 |
| shadow-mode-logging.md | 三档模式、日志格式、影子审核流程、阈值初值 | 可以 |
| dedup-and-rewrite-policy.md | 重复与转述稿：片段级增量新颖度、非二极管原则、例子 | 可以 |
| non-article-pages.md | 列表页 / feed / 付费墙 / 元数据页的识别与处理、标记列表 | 可以 |
| lessons-fast-jev-compaction.md | 从 fast-jev-compaction（Jev 压缩对话插件）借鉴的点：token 估算公式（已用夹具验证）、传输/逻辑分离、纯库+适配器、阶梯降级；函数钩子挂载路线的比较 | 可以 |
| status.md | 当前进度、卡点、待办、文件地图 | 可以 |
| private-jev-evidence.md | 社区实测数字与负面结果 | **不能**：TypeSafe MCA 2.3(f) 禁止发布 Jev 性能信息，已在 .gitignore 排除 |

命名规则：`private-` 前缀的文件被 .gitignore 排除，永不进公开仓库。
