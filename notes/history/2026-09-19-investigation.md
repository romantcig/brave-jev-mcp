# 历史记录：联网调查、据此修订的设计与拍板项（2026-09-19）

> 归档自 PLAN.md v2 第 10、11、12 节，原文保留。接口事实已并入 notes/jev-api.md、notes/brave-llm-context.md、notes/jev-question-writing.md；
> 第 11 节的修订设计与第 12 节的四项拍板（老大当日默认同意：接入路径、钉版本、网关经手方、发布不带数字）均已进入决策表。
> 文中"第 N 节"指 v2 的节号。

## 10. 联网调查结论（2026-09-19 第二轮）

来源：docs.typesafe.ai 全站索引与 cookbook、typesafe-ai 官方 GitHub（skills、sdk-js、system-one-adapter-python）、awesome-jev 清单、HN 发布串 493 条评论、四篇独立实测、Brave LLM Context 官方文档页、上游源码。仓库副本在 `~/.zcode/tmp/260919-053010/repos/`，文档副本在 `~/.zcode/tmp/260919-053010/docs/`。

### 10.1 拿 key 的路径：不必等 waitlist

| 路径 | 模型 ID | 端点 | 协议 | 费用 | 备注 |
|---|---|---|---|---|---|
| TypeSafe 直连 | `jev-latest` | `POST api.typesafe.ai/v1/systemone` | 原生 | $0.042/M 输入 | waitlist |
| OpenRouter | `typesafe/jev-1.13`（钉版 `typesafe/jev-1.13-20260917`） | `POST openrouter.ai/api/alpha/decisions` | 与原生完全相同（state/questions/noul） | 同价，预付费 | 已验证端点存在（无 key 返回 401），上下文 32000 |
| Vercel AI Gateway | `typesafe-ai/jev` | `POST ai-gateway.vercel.sh/v4/ai/evaluation-model` | AI SDK v4 评估协议：问题类型 `boolean` 代替 `noul`，请求体 `{state, questions, providerOptions}`，置信度在 `providerMetadata.typesafe.confidence` | 同价；**免费档每月 $5**，首次使用即生效，不买 credits 也能用 | 支持逐请求 ZDR/no-training；有社区项目专门在免费额度内运行 |
| Cloudflare AI Gateway | `typesafe/jev` | Workers `env.AI.run` | 另一套 | 未细查 | 不考虑 |

每月 $5 免费额度远超个人搜索用量。

### 10.2 Jev 接口硬事实（官方文档 + SDK 类型）

- 三种问题：noul（只回概率，**没有 confidence 字段**）、choice（1–255 个选项，回 choice + probabilities + confidence）、score（2–10 档，回 score + probabilities + legend + confidence）。instructions 和 criteria 都接受 JSON 对象/数组，官方建议多部分问题用带键名的对象写。
- 上限：单请求 state+全部问题 64k，state+最长单题 32k；**超限直接拒绝**（社区核实：返回 422 类错误，不是静默截断）。速率 250k token/s、1200 请求/分，官方声明限额动态调整。
- 错误码：401、422（体校验失败，会指出字段）、429、529（过载）；官方要求指数退避。
- 问题 key 不送模型，题干必须自含完整语义。回复带实际模型名 `model` 和 `usage.input_tokens`。
- 所有答案四舍五入到两位小数。
- 官方 jaggedness 页明文：state 里无关内容越多准确率越低（"context rot"），建议"先在代码里过滤，只送问题需要的字段；没法过滤时用一道 noul 先判相关性"，并点名 classifying_rag_passages cookbook 为范例。
- 版本：`jev-latest` 会随发布移动，**官方建议"若已按某版本调好阈值，就钉版本 ID，按自己的节奏迁移"**。
- 语言：英文最好；CJK "handled but not equally well"，要自测并盯 confidence。一位挪威语实测者报告 Jev 分词器在挪威语上约 2.06 字符/token，32k 上限对应约 6.4 万字符；中文预计更差。
- 法务：MCA 2.3(f) **禁止发布关于服务的 benchmark 或性能信息**；2.3(a) 禁止把服务作为独立服务转售；4.1 不用客户数据训练；企业档可 ZDR。jevcal 作者因此刻意在 README 里不放任何 Jev 数字。

### 10.3 官方 cookbook 里的直接先例

- **Classifying RAG passages**：state 是 `{query, passage:{id,title,text,source_type}}`，一个来源一次请求，四道 noul：is_relevant、contains_answer_evidence、contradicts_query_premise、contains_prompt_injection。阈值全部放在一个 dict（0.70/0.70/0.45/0.55），代码按固定顺序比较，先判注入再判矛盾再判相关最后判证据。文中 72 个检索段落至少三分之二被排除。四题都不问"该不该保留"，保留规则只在代码里。
- **Parallel questions**：同一篇文档 13 道题合并成一次请求，答案与分开问完全一致，便宜 12.2 倍、快 10 倍。
- **Re-ranking**：每个 (query, candidate) 对一次请求一道 noul，1200 次调用；top-1 从 5% 提到 18%。
- **Line-by-line search**：一道 choice 218 个选项一次请求，外加一道 noul 判"文档里到底有没有答案"。
- **Self-consistency**：不确定区间送人工复核。

### 10.4 社区实测与负面结果

（实测数字表已移至 notes/private-jev-evidence.md，公开文件不留 Jev 性能数字。定性结论：边界清晰的是非题 Jev 可靠；非英语可用、score 类型可靠；兜底设计参考 mastra 模式；拆维度只在单题弱时有帮助，单题已强时拆维度误报反增；Jev 单独重排不赢向量检索，只适合做门槛；题目保持单层可观察，choice 选项集要干净。）

### 10.5 Brave LLM Context 文档补充

- 上游源码 `schemas/input.ts` **已经声明**了 `context_threshold_mode`（strict/balanced/lenient/disabled，默认由 API 自校准）、`enable_source_metadata`、`maximum_number_of_snippets`、`maximum_number_of_snippets_per_url`、`spellcheck`；现补丁的白名单把它们从工具声明里去掉了，源码路线下可以直接用。
- `strict` 官方说明："precision matters more than recall"。这是 Jev 之前一道零成本的 Brave 侧门槛，阶段一无 key 也能实测效果。
- 片段可能是纯文本或 JSON 序列化的结构化数据（表格、schema、代码块），官方要求后处理两种都要能处理。
- token 预算是硬约束，snippet 数量上限在预算允许更多时不起作用。
- 2026-07-31 起默认新内容抽取管线，可用 `Api-Version: 2026-02-06` 钉旧管线。
- query 上限 600 字符 75 词（比 MCP 声明的 400/50 宽）。


---

## 11. 据此修订的设计（默认做，老大可否决）

1. **请求模式定为单来源并行**：state = `{query, intent, source:{id, url, title, snippets[]}}`，每个来源一次请求，来源级题和该来源的片段级题合并在同一请求里。依据：官方 jaggedness 页的 context rot 警告、RAG cookbook 先例。批量模式不再作为候选。
2. **来源级题在第 9 节五道之外再加一道直接题** `worth_keeping`："这一页对 intent 有独立信息价值"。影子期同时记录直接题和维度题的裁决，用真实样本比较哪种误杀少后再定主判据。依据：agentjournal 的对比结果。
3. **Jev 客户端支持三个后端**，环境变量切换：TypeSafe 直连、OpenRouter（协议相同）、Vercel AI Gateway（boolean/noul 映射、置信度取自 providerMetadata）。阶段二从免费的 Vercel 网关或 OpenRouter 起步，不等 waitlist。
4. **Brave `context_threshold_mode` 纳入阶段一实验**：同一 query 分别用默认与 strict 跑，比较片段数与质量；若 strict 就能去掉大半导航垃圾，Jev 的负担更轻。
5. **兜底照抄 mastra 模式**：请求级超时（初值 5s）、连续 3 次失败熔断 60s、熔断期间只跑本地规则并裁回预算（第 4.2 节定义不变）。
6. **超限处理**：发送前用保守估算（中文按 1 字符/token 计）确认 state+最长题 < 32k，超了就按 Brave 顺序砍掉末尾片段再发，绝不让 Jev 返回 422 后整体兜底。
7. **发布版不含任何 Jev 准确率、延迟、成本对比数字**（MCA 2.3(f)），只含代码、阈值常量和方法说明；影子期数据只留本地。
8. **阈值与题干集中在一个文件**（官方 skill 与 cookbook 一致要求），改策略是改常量不是改题。
9. 片段级预筛先做代码版：不含 query 任一实词且短于阈值的片段直接删，减少送 Jev 的量。

---

## 12. 待老大拍板（本轮）

1. **接入路径**：Vercel AI Gateway 免费档（需要 Vercel 账号，每月 $5 额度足够）、OpenRouter（需要预付费账号）、还是继续等 waitlist。我的推荐：先看你手头已有哪个账号；都没有就开 Vercel。
2. **版本钉不钉**：第 7 节决定用 `jev-latest`。官方文档明确建议"调好阈值后钉版本，自己择时迁移"，OpenRouter 也提供钉版 ID。改为"钉版本 + 新版本发布后跑样本回归再手动切换"是否可接受。
3. **数据经手方**：走网关会多一个数据经手方（Vercel 或 OpenRouter）。Vercel 网关支持逐请求 ZDR 与 no-training。是否接受。
4. **发布约束**：GitHub 版本不能带性能数字，README 只能写"用 Jev 过滤"和方法。是否接受。
