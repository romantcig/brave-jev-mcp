# notes/ 索引

PLAN.md 是决策记录；这里放可复用的事实与经验，按主题拆分，随调查更新。

| 文件 | 内容 | 能否随仓库公开 |
|---|---|---|
| jev-api.md | Jev 接口硬事实、三条接入路径的精确请求形状、错误码、限额 | 可以 |
| jev-question-writing.md | 怎么给 Jev 写题：官方规则、cookbook 先例、我们的题库草案 | 可以 |
| brave-llm-context.md | Brave LLM Context API 的参数语义、响应形状、计费、上游服务器结构 | 可以 |
| local-rules-design.md | 本地规则层八步设计与夹具观察 | 可以 |
| shadow-mode-logging.md | 三档模式、日志格式、影子审核流程、阈值初值 | 可以 |
| status.md | 当前进度、卡点、待办、文件地图 | 可以 |
| private-jev-evidence.md | 社区实测数字与负面结果 | **不能**：TypeSafe MCA 2.3(f) 禁止发布 Jev 性能信息，已在 .gitignore 排除 |

命名规则：`private-` 前缀的文件被 .gitignore 排除，永不进公开仓库。
