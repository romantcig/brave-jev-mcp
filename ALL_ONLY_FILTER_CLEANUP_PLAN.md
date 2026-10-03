# All-Only Filter Cleanup Plan

日期：2026-10-03。状态：**已复审修订，待实施。**

目标：Jev 过滤只维护全量共享上下文和当前新题，彻底移除 single、旧评分题回退、Jev 请求的 32K／64K 预检与降级体系，包括它们在配置、类型、日志、测试和维护脚本中的依赖。

## 1. 已确定的边界

老大本轮明确决定：

1. 只保留 all。零候选不请求；一个或多个候选都用 `state.sources[]`，一次搜索最多组织一次 Jev 逻辑请求。
2. 退役 `jev.context_mode`。
3. 退役 `jev.temporal_context`，当前时间上下文评分题成为唯一模板。
4. 移除 Jev 请求的 32K／64K 检测、相应估算、15% 预检余量、single 阶梯和所有自动回退；不替换成切块、分组、删题、缩短正文或其他输入限额。
5. 本轮只修改计划。源码实施、构建、本机配置更新和 MCP 重启属于后续工作。

Jev 服务限制未变，HTTP 拒绝沿用现有错误处理和保守保留语义。

工程验证使用零网络桩和既有夹具，不以新增模型评测或 token 调查为前置。

## 2. 调查基线与证据范围

本次检查本地源码、测试、维护脚本与文档。

- 调查时 Git HEAD：`7d4d344`；**有效基线是包含未提交改动的当前工作树**。
- 当前源码版本标识：`filter-rules-14`、`jev-context-2`、样本格式 v4。
- 当前题库：四道来源级题，加每片段一道评分题；all 的时间上下文新题已在源码中，仍有开关和旧模板。
- `src/filter/temporal.ts`、对应测试和若干根目录计划尚未入库；执行时必须保留这些既有工作。
- `dist/`、旧日志、文档中“已上线”或“尚未安装”的描述不能替代工作树事实；本次未判定现有 MCP 进程装载了哪一版。
- `dev/filter-*.ts`、`notes/`、`.planning/`、`AGENTS.md` 受忽略规则影响。只看 `git ls-files` 或默认搜索会漏掉本地依赖，调查已补查这些文件。

### 2.1 实际依赖链

```text
config.ts 的 contextMode / temporalContext
  → pipeline.ts 候选日期提取、all / single 编排和三种回退
  → questions.ts 单来源 state、旧评分题、新评分题及双模板哈希
  → context.ts 命名空间、双限额规划、局部题表、答案投影
  → client.ts 按 source / sources 分流、single 阶梯、第二次限额校验
  → ClassifyOutcome / JevPerSourceStats / JevRequestRecord
  → sample.ts 完整样本与 stats.jev.requests → logging.ts JSONL 摘要
  → 单元测试、夹具回放、stdio 冒烟、全量冒烟、本地实验入口

questions.ts 的评分 criteria → verdict.isUsableSnippetScore
  → context.ts 评分有效性投影 / 片段删除 / 样本 scored
```

### 2.2 已确认的清理落点

| 位置 | 当前耦合 | 必须处理的结果 |
| --- | --- | --- |
| `src/filter/config.ts` | 默认 single、两个配置开关及其解析 | 删除配置键对应的内部字段、默认值、枚举和解析分支 |
| `src/filter/types.ts` | 两种 state、模式类型、回退类型、预算类型、阶梯字段 | 只保留全量 state 和仍有业务意义的记录 |
| `src/filter/jev/questions.ts` | `buildState`、旧 `buildQuestions`、两套 score、双模板哈希 | 只生成当前四道来源题与当前新 score；哈希只覆盖生效题库 |
| `src/filter/jev/context.ts` | `planAllRequest` 返回成功／超限联合；另有仅测试消费的 `localQuestions` | 变成无预算职责的请求构造器，删除超限联合和冗余局部题表 |
| `src/filter/pipeline.ts` | single 派发；单候选、预检、客户端拒绝三条回退；可选时间输入 | 收敛成一个非空候选请求；日期提取常开 |
| `src/filter/jev/client.ts` | `applyOversizeLadder`、双限额复检、按模式选择解析规则 | 直接发送完整载荷；统一采用现有 all 的逐题隔离解析 |
| `src/filter/jev/verdict.ts` | 旧 `SNIPPET_LEVELS` 决定评分范围；短数组按砍尾前缀应用 | 改用新 criteria；评分数组与幸存片段等长时才应用 |
| `src/filter/sample.ts` | 模式切换字段、预算估算、阶梯说明、v4 配置快照 | 新写 v5；删除失效字段，保留真实派发和身份映射 |
| `src/filter/index.ts` | 导出 `JevRequestMode` | 删除退役导出，不留兼容别名 |
| `src/filter/version.ts` | 规则、布局标识和当前行为注释 | 按实施时基线递增；历史版本说明保留历史含义 |
| `src/tools/llm_context/index.ts` | 已捕获检索时间，但注释仍描述开关和 single 回退 | 保留时间捕获和内部传递，更新注释与宿主测试 |
| `dev/full-context-smoke.mjs` | 消费 `planAllRequest`、`estimates`、旧开关、v4 | 改用唯一构造器，去掉请求限额依赖与旧题计数 |
| `dev/stub_fetch.mjs` | 按 `state.source.id` 回放，锁旧来源题及旧 score | 改为验证全量数组、当前题键和逐来源映射 |
| `dev/smoke_stdio.ts`、`dev/smoke-rollout.ts` | 期待逐来源 HTTP、历史题键及样本 v4 | 改为一次共享请求；保留各来源判断和三档过滤模式断言 |
| `dev/compare.ts`、夹具测试 | 依赖 `state.source.id` 查历史录制 | 改为明确的固定回答注入，不能冒充当前题目的实测 |
| `dev/dump_local_rules.ts` | 本地候选输出、旧 probe 配套说明 | 保留候选查看用途，核对新输出并更新说明 |
| `dev/filter-demand-*.ts` | quality 分支会将历史 single 请求交给当前客户端 | 旧 quality 仅离线回放；独立比较实验明确请求类型和传输边界 |

两个 stdio smoke 入口仅产物保留方式有少量差异，协议断言同步迁移。

## 3. 清理后的运行契约

### 3.1 请求与时间上下文

- `mode=off`：仍然只走既有本地过滤，不请求 Jev。
- `mode=test/on` 且未注入可用分类器：保持现有 `no_key` 处理。
- 零候选：零次 Jev 逻辑调用和 HTTP，不构造空问题请求。
- 一个或多个候选：完整候选数组进入同一次请求。只有一个元素也使用新题和 `sources[0]`，不走特殊模板。
- 同一搜索的重试复用完全相同的 body、检索时间和题目；重试属于同一逻辑请求。
- 全量上下文指本地步骤 1–4 后的全部候选，不把已删除的样板内容重新放回 state。
- 候选保持 Brave 原序；来源 ID 仍是 `s{braveIndex}`，数组位置与来源 ID 分开处理。

时间输入沿用 `temporal.ts`：

- 每个候选都带 `brave_page_date`，没有可靠日期或归并冲突时为 `null`。
- `retrieval_time` 来自宿主发起 Brave 请求前捕获的那一个时刻；合法时携带，缺失或非法时省略。
- 纯库和回放不读取当前时间补值。旧样本回放显式传原检索时间，不能填“今天”。
- 页面日期、相对时间和同事件状态的解释继续使用当前新题原文；不增加按年龄删页或独立时间题。

### 3.2 唯一题库

保留当前 `all + temporal_context=true` 的实际题意、题目顺序、阈值和 criteria，不在清理中重新设计提示词。

- 来源级：`has_original_reasoning`、`is_template_filler`、`is_off_topic`、`is_listing`。
- 片段级：当前时间上下文评分题，每个候选片段一道。
- 总题数仍为“候选数 × 4 + 候选片段数”。
- 来源题的 `source` 路径转换保持现有结果；新 score 直接按数组位置生成。
- 新 score 不添加来源题的 `GLOBAL_INSTRUCTION` 前缀，也不对整段新题做 `source` 正则替换；其中普通英语 `A source's` 必须保持原样。
- 缺少检索时间或页面日期只影响可用输入，不触发旧题、短题或另一套 criteria。

### 3.3 失败与计数

保留 HTTP 错误分类、超时、重试、退避、Retry-After、熔断和跨搜索并发闸。

- 删除本地生成的 `too_large`，不把 HTTP 413／422 改造成新的本地超限分支；它们按现有通用非重试 `validation` 处理。
- 已派发后失败：保存实际请求与可取得的用量，相关来源按现有保守规则处理，不拆成逐来源请求。
- 熔断未派发：载荷为 `null`，记 `breaker_open`，HTTP 次数为 0。
- 注入依赖意外 reject：继续按现有防御语义记网络失败；没有派发证据时不能伪造实发记录。
- `n_requests` 仅在 outcome 带 `dispatch` 时加一；`n_http_attempts` 累计已知真实尝试，用量只在请求级累计。
- 回答桩可 `answered=true` 而 `dispatched=false`；此时计零请求、载荷保持 null。缺少用量完整性信息时 `usage_complete=false`，不由 answered 自动推定。
- all 解析的逐题错误隔离成为唯一行为：坏答案不能使其他来源的有效答案一起失效；顶层协议错误仍按原规则失败。

现有 `runRequest` 对无 dispatch 的 answered 也计一次请求，零网络复现得到 `n_requests=1`、`n_http_attempts=0`、`state=null`。实施时修正这一分支。

## 4. 实施任务与顺序

完成 A–F 后统一构建和验收。

### 任务 A：冻结基线和唯一数据契约

责任文件：`src/filter/types.ts`、`src/filter/index.ts`；执行记录写仓库外临时目录。

1. 开工时核对工作树中的题库、日期逻辑和版本，保留既有未提交改动。
2. 将修改前 all＋新题的确定性构造结果存入仓库外临时目录，用同一候选、query/intent 和检索时间做等价对照。
3. 将 `JevState` 直接定义为当前全量结构，删除 `JevSingleState`、`JevAllState` 联合及多余别名。调用方统一使用 `JevState`。
4. 候选 `bravePageDate` 和请求 `brave_page_date` 均为 `string | null`。
5. 删除 `JevRequestMode`、`JevFallbackReason`、`AllBudgetEstimates`、`JevLadderLevel`，移除公共导出。
6. 删除 `ClassifyFailKind` 的 `too_large`，以及 outcome／per-source 中的 `ladder`、`sent_snippets`。
7. `JevRequestRecord` 删除 `mode`、`requested`、`effective`、`fallback_reason`、`planned_estimates`；请求 ID、来源 ID、mapping、真实派发与用量字段保留。
8. `not_dispatched_reason` 保留 `skipped | breaker_open`，原因未知时省略。

### 任务 B：删除配置开关，固化当前新题

责任文件：`src/filter/config.ts`、`src/filter/jev/questions.ts`、`src/filter/jev/context.ts`、`src/filter/jev/verdict.ts`、对应测试。

1. 配置解析只保留 Jev 的 model、timeout、concurrency。删除两个开关的集合、默认值、解析、告警文案、示例和内部字段。
2. 遗留 JSON 中的两个键按已有未知键规则忽略。
3. 删除 `buildState`、旧 `buildQuestions`、`singleScoreInstructions`、旧 `SNIPPET_LEVELS`。`verdict.ts` 的 `isUsableSnippetScore` 改用唯一新 criteria 的长度；当前仍为三档，合法范围不变。
4. 明确唯一生成接口：来源题生成器按来源数组位置返回四题；片段评分生成器按来源与片段位置返回当前新题。可使用 `buildSourceQuestions`、`buildSnippetScoreQuestion`、`snippetScoreInstructions`、`SNIPPET_CRITERIA` 这些名称，不保留旧 API 别名。
5. 来源题仍复用当前 `SOURCE_QUESTIONS` 和来源总指令；新 score 的题干与 criteria 逐字保留。
6. `QUESTION_SET_ID` 只哈希现行来源题、来源总指令、新 score 完整模板及 criteria。
7. 将 `planAllRequest` 改为 `buildContextRequest`：返回 `{ state, questions, entries }`，不再返回 `ok/plan/reason/violation/estimates` 包装；`AllRequestPlan` 收敛为对应的单一返回类型，不保留旧规划器别名。
8. 删除 `AllTemporalContext` 的启用语义，构造器只接收可选的已归一检索时间。日期和新题的生成不再由参数是否存在决定。
9. 删除 `AllPlanResult`、预算检查函数、32K／64K 常量、预检余量、最长题／全部题 token 估算及相关 import。
10. 删除仅供测试消费的 `localQuestions`，测试直接验证最终请求和 mapping。
11. 保留 `{sourceId}__{localKey}`、原题序及来源 ID；`allQuestionKey` 无需改名。

### 任务 C：收敛管道与客户端

责任文件：`src/filter/pipeline.ts`、`src/filter/jev/client.ts`、`src/filter/jev/verdict.ts`、`src/filter/temporal.ts`、`src/tools/llm_context/index.ts`。

1. `jevCandidatesFromTable` 删除布尔参数，始终完成原始日期选择、归并消解和候选日期绑定。同步更新两个候选收集导出函数。
2. 管道对检索时间归一一次；非空候选直接调用唯一构造器，再调用一次 classify。
3. 删除 `requestedMode`、`singleFallbackReason`、`useAll`、single dispatch、该路径的 `Promise.allSettled`，以及单候选／预算／客户端拒绝的三种回退。
4. 删除仅服务多个 single 请求的局部编排状态。请求记录可以继续使用本次搜索内的 `j1`，记录数组保留零条／一条结构，便于样本和 JSONL 继续关联。
5. 保留 `runRequest` 的载荷捕获，按 §3.3 修正请求计数与用量完整性默认值；保留逐来源投影、Brave 原序和来源级验证。
6. `projectSourceAnswers` 继续依赖实际题位及映射，片段数来自当前请求映射，不再读取 outcome 的 `sent_snippets`。可将内部参数改名为 `snippetCount`，避免留下阶梯语义。
7. `snippetCountOfState` 只读取 `sources[arrayIndex]`，删除 `.source` 分支；异常位置的未知值处理保留。
8. 客户端删除 `applyOversizeLadder`、`SNIP_KEY_PATTERN` 的阶梯用途、双限额 import、按 state 形状分路及所有阶梯临时变量。完整 body 只构造一次，重试原样复用。
9. 删除 `parseJevResponse` 的 `isolateInvalidAnswers` 参数，默认执行现有 all 逐题隔离语义；调用方不再传模式布尔值。
10. 宿主继续在 Brave 调用前捕获时间。只更新与退役行为相关的注释和测试，不扩大上游适配触点，不添加公开 MCP 参数。
11. `applySnippetScores` 要求分数数组与幸存片段等长，长度不匹配时跳过该来源的评分删除。删除“短数组代表砍尾”的说明和用例。当前 all 投影在缺答或错型时不产出整组 `snippet_scores`，逐题收到的值仍供样本记录；正常 all 行为不变。

保留步骤 6–10 的裁决顺序、四题门槛、原创论证保护、去重、片段评分阈值和 Brave 原序。

### 任务 D：删除记账残留并升级样本

责任文件：`src/filter/sample.ts`、`src/filter/types.ts`、`src/filter/version.ts`、样本／日志／宿主测试。

1. 成功和错误样本均升级为 **format_version 5**。`sample.test.ts` 的当前写入再读回用例改验 v5；额外旧答案键测试继续验证当前解析与裁决，不引入历史样本类型兼容层。
2. 新配置快照的 `jev` 只含 model、timeout_ms、concurrency，删除 `context_mode`、`temporal_context`。
3. 请求级记录与 JSONL 摘要同步去掉模式切换和 `planned_estimates`。`JevRequestSummary` 由新类型派生，不重新定义一套失效字段。
4. 保留 `request_id`、`source_ids`、`array_index`、题键／片段键 mapping，以及 `state/questions/answers` 的真实请求证据。
5. 保留 `in_state`、`score_question_sent`、`scored`、`score`、`score_applied`、`source_verdict_valid` 的分别记账。
6. 未派发载荷仍为 null；已派发但失败仍保留载荷。JSONL 继续不放正文，正文仅进样本。
7. 更新当前语义注释，移除“阶梯后”“single 恒 0”等运行说明。对历史 v1–v4 的说明保留版本前提。
8. 按执行时基线递增 `FILTER_RULES_VERSION` 和 `CONTEXT_LAYOUT_ID`。若基线仍为 14／2，则新值为 `filter-rules-15`／`jev-context-3`；并发任务若已推进版本，使用其后的新值。
9. 旧样本和两份 `.jev.json` 夹具不改写、不升级、不伪造新题回答。生产代码不为读旧样本继续保留 single 类型；历史查看工具按文件自身格式解释。

### 任务 E：迁移当前维护入口，冻结历史实验

责任文件：full-context、stub、两个 stdio smoke、compare、dump、demand 入口及相关说明。

**当前入口必须能用：**

- `full-context-smoke.mjs` 使用唯一构造器；准备载荷和实际管道调用必须使用同一个显式检索时间，不能在两个位置分别取当前时间。
- 去掉旧开关、`planned.ok`、`estimates`、`retry_upper_estimate`、`chargedEstimate` 等对退役规划器的依赖，以及已无意义的 `temporal_questions` 旧独立时间题计数。
- 该脚本现有“60000 估算 token”是过去一次冒烟的累计约束，不是 Jev 64K 上限。本轮将此固定轮次额度及其估算字段从通用入口退役；保留“两份材料、最多两次逻辑请求／六次 HTTP”、离线禁网、运行目录认领和证据写入，避免重建一套输入 token 检测。
- `--offline` 核对构建、模型、题库和完整载荷身份，拒绝旧 identity。
- `stub_fetch.mjs` 接收 `state.sources[]`，校验来源 ID／URL、数组位置、当前四题和每片段 score 的全局题键，再返回单个完整 answers 表。
- stdio 冒烟的 Jev 请求数应为 test/on 各 1、off 为 0；每来源 answered/validation、样本指针、用量与真实请求数仍分别验证。
- 两个 smoke 入口中的 v4、旧来源题、12 次请求和历史输出计数断言必须逐项处理；不能仅改请求数让旧题校验失效。
- `dev/compare.ts` 的 off 路径继续可用；test/on 改为接收完整共享请求并按全局题键注入固定回答，清除建议使用旧 probe 重录当前题目的文案。
- `dev/dump_local_rules.ts` 保留为本地候选查看工具，更新 probe 配套说明并核对新候选输出；它不构造或发送 Jev 请求。

**固定回答与真实回放分开：**

- 两份 `.jev.json` 包含当前四道来源题的答案。按候选 ID 查固定数值，再按实际题键表映射，例如 `s0` 的 `is_off_topic` 对应 `s0__is_off_topic`；旧额外题不参与裁决。
- 片段评分按当前身份和测试给定的对应关系映射，缺失或拆分后的片段不按压缩位置套用旧分数。旧数值用于新题时标为合成桩，只验证管道行为。
- 纯 classify 回答注入按 §3.3 计零实发；验证传输账目时使用 fetch 桩并注明合成用量。真实回放保留原请求身份和传输事实，不将旧 single 用量合计当成共享请求用量。

**demand 实验：**

- `filter-demand-plan.ts` 的 quality 分支原样读取 round16 single 请求，`filter-demand-run.ts` 缺少缓存时会把它交给当前客户端。旧 quality 作业改为仅离线回放；实发模式在调用客户端前拒绝这些作业。
- `filter-demand-loader.ts` 的 local/inline/dual 是独立比较实验布局。保留实验，使用独立请求类型和传输接口，不通过 `any` 传给只接受生产 `JevState` 的分类器。若复用传输实现，将通用传输与生产请求类型分开，保持重试和用量语义。
- 检查 plan、run、loader、audit 的调用关系。旧 quality 的 `.source` 读取只能到达离线回放；缓存继续核对完整请求身份。
- `filter-experiment-budget.ts`、`filter-demand-run.ts` 删除 32K／64K 断言和最长单题估算，保留实验累计费用预留、`--live` 及逐次 HTTP 记账。

**历史实验的处理边界：**

- `dev/jev_probe.py` 已注明只服务 v3 历史十题，但仍能真实发 single。它从当前维护入口退役：删除现行使用说明及活跃脚本入口；已跟踪代码由 Git 历史保留，冻结夹具保留。不改写成新题的第二套 Python 生成器。
- 本地忽略脚本中，以下文件明确依赖旧 `buildQuestions`／旧 `SNIPPET_LEVELS` 或旧 single 请求：`filter-experiments.ts`、`filter-distribution-experiments.ts`、`filter-distribution-record.ts`、`filter-five-question-ablation.ts`、`filter-round11-targeted.ts`、`filter-round13-time.ts`、`filter-round13-time-concise.ts`、`filter-round13-holdout.ts`、`filter-round13-spotcheck.ts`、`filter-round14-rollout.ts`、`filter-round15-content.ts`、`filter-round16-quality.ts`、`filter-round17-order.ts`、`filter-round19-retest.ts`、`filter-six-question-validation.ts`、`filter-signal-experiments.ts`、`filter-tail-experiments.ts`。
- 另有旧 single 注入或比较入口：`filter-abstention-experiments.ts`、`filter-reasoning-ablation.ts`、`filter-rollout-review.ts`、`filter-round10-review.ts`、`filter-signal-calibration.ts`、`filter-tail-isolation.ts`、`filter-round13-scoped.ts`、`filter-round16-semantic.ts`。
- 上述入口登记冻结，从现行说明摘除，不再支持搭配当前生产源码运行；保留本地文件和实验结果。仍被维护入口导入的依赖必须迁移，不能只登记冻结。
- `filter-round16-common.ts`、`filter-round17-common.ts` 和旧语义比较脚本还有独立的 32K／64K 检测与按 64K 拆题逻辑；它们属于旧轮次方案。冻结记录不重写，不能将其作为新维护入口继续调用。

dev 不在默认 tsc/npm test 范围内，维护入口需显式验证。

### 任务 F：文档和本机配置收口

责任文件：`FILTERING.md`、`README.md`、`AGENTS.md`、当前本地说明与相关旧计划。

1. `FILTERING.md` 改为唯一 all 和新评分题的说明；最小配置只需 `mode: "test"`，不再要求两个开关。写清 v5 的核对方法。
2. 删除“关闭 temporal 回旧题”“切 single 回退”“超限降级”的现行操作说明。仍可通过 `mode=off` 关闭 Jev；若回滚代码，用此前完整构建版本，不在新代码内保留备用题库。
3. `README.md` 调整链接标题，指向正式过滤配置说明，不继续称作双模式试运行。
4. `AGENTS.md` 的当前项目约束更新为本计划的请求策略。
5. 更新 `notes/status.md`、`notes/test-mode-logging.md`、`notes/README.md` 和 `filter-notes.md` 的当前状态；旧实验记录只加必要的退役指向，不改写原始结果。
6. `notes/jev-api.md` 保留官方限制记录，注明本项目预检已退役。
7. 根目录旧计划中涉及 single、旧评分回退、预算统一或旧样本格式的要求，以本计划为后继决定；在相关计划顶部加简短去向说明，保留其历史内容。重点涉及 `MAINTENANCE_SIMPLIFICATION_PLAN.md`、`SOURCE_QUESTION_TRIM_PLAN.md`、`TEMPORAL_CONTEXT_SCORING_ROLLOUT_PLAN.md`。
8. `.planning/` 是历史工程记录，本轮不启动新 GSD 阶段；必要时只在当前状态入口注明 JEV-05 与旧请求组织已退役，不重写已完成阶段的验证结论。
9. 安装阶段按 `notes/private-local-env.md` 找到实际配置，只删除两个退役键，保留其他配置与环境变量。

## 5. 保留清单：避免按关键词误删

| 保留对象 | 保留原因 |
| --- | --- |
| `src/filter/budget.ts`、`clamp.ts`、Brave schema 上限 | Brave 请求参数和最终输出预算，独立于 Jev 输入限额 |
| `src/filter/tokens.ts`、`estimateTokens` | 最终输出规模统计与步骤 9 仍使用；清理注释中的退役用途即可 |
| `BRAVE_MAX_TOKENS = 32768` | Brave 参数约束，不能因为数值接近 32K 一并删除 |
| `overfetchFactor` 和步骤 9 的 `trimToBudget` | 超量抓取后的返回预算仍然有效 |
| `temporal.ts` 及检索时间捕获 | 当前唯一评分题需要真实日期上下文 |
| 真实 `input_tokens`、`usage_complete`、HTTP 次数、耗时 | 请求事实记录，不属于估算预检 |
| 超时、重试、熔断、并发闸 | 仍处理正常运行中的传输问题和多搜索并发 |
| 来源 ID／数组下标／片段键／题键映射 | 多来源共享请求依然必须正确归属答案 |
| 四题裁决、score 有效性、缺答保守处理 | 保证错误回答不会变成删除信号 |
| `off/test/on`、旧 `shadow → test` 兼容 | 与 single/all 请求组织不是同一层，未在本轮退役范围 |
| 原始夹具、旧日志、实验记录 | 作为历史证据保留；不维持生产兼容代码 |

## 6. 验证矩阵

验证此次删除涉及的构造、传输、裁决和记录行为。

| 范围 | 核心断言 |
| --- | --- |
| 配置 | 解析结果无两个退役字段；旧 JSON 写 single、all、false、true 均不能切换路径；其他配置与默认值保持 |
| 唯一请求构造 | 零候选在管道不调用；一候选和多候选都用 `sources[]`；单请求完整包含候选和题目 |
| 题库等价 | 同一多候选输入，清理前 all＋新题与清理后实际 state/questions/映射等价；哈希只覆盖现行完整模板 |
| 单候选新行为 | 新 score、日期字段、命名空间题键及分数应用正确 |
| 时间输入 | 缺失／非法检索时间不补今天；无日期／冲突为 null；宿主在 Brave 前捕获，重试原样复用 |
| 映射 | 来源 ID 不连续、前面来源被删、归并与 JSON-LD 拆段后，题位和来源归属仍正确 |
| 检测已退役 | 用一个超过旧检测范围的有限合成请求、桩 fetch 验证完整发送且不删正文／删题／拆请求；不重新维护边界计算器 |
| 响应解析 | 坏的单题不拖垮其他来源；顶层坏响应仍失败；缺答、错型、越界分数保守处理 |
| 传输 | 既有 auth、validation、超时、网络、重试、熔断和并发测试改用唯一 state 后继续成立 |
| HTTP 拒绝 | 代表性的 413／422 走通用 validation，不拆请求、不重试、不生成本地 too_large |
| 账目 | 有回答无 dispatch 计零请求；共享用量只计一次；重试、部分已知用量及完整性分别记录 |
| 评分契约 | 合法范围来自新 criteria；等长评分正常应用，长度异常不套前缀 |
| 样本 v5 | 成功／错误路径均升级；退役字段不存在；实际请求、答案、最终返回和映射齐全 |
| 样本真实性 | dispatched、answered、scored、score_applied 分开验证；未派发与缺答不写成已评分 |
| 过滤语义 | 固定回答下 test 与 on 的最终正文一致；off 与既有本地规则期望一致；步骤 9 和 Brave 顺序不变 |
| stdio 端到端 | 新构建使用唯一 all，三档模式、工具声明、无 outputSchema/structuredContent、状态行及样本路径均正确 |
| 开发入口 | full-context plan/offline、compare、dump 可运行；旧 identity 拒绝，合成回答明确标注 |
| demand 边界 | 旧 quality 可离线回放且实发前拒绝；独立比较使用独立接口；累计费用控制保留 |

具体测试迁移：

- `config.test.ts`：删除开关默认／合法值矩阵，改成退役键不影响行为；删除测试配置对象中的两字段。
- `questions.test.ts`：删除旧 score、旧 state 构造测试，保留四题、当前新题原文、criteria、唯一哈希及历史响应协议用途。
- `context.test.ts`：删除双限额边界组、旧包装结果和 `localQuestions` 断言；覆盖单候选、最终题目、显式 mapping 与逐来源投影。
- `client.test.ts`：删除 oversize ladder、零 HTTP too_large 组；把仍有效的重试／熔断／并发／解析测试统一到全量 state。
- `pipeline.test.ts`：删除三条回退、cut_tail 对齐和开关回旧题组；改写普通过滤用例中的 single 桩，不能连有效的裁决回归一起删掉。
- `pipeline.fixtures.test.ts`：按任务 E 更换固定回答适配；纯回答桩按 §3.3 计零实发，classify 调用一次，逐来源裁决仍逐项检查。
- `verdict.test.ts`：验证新 criteria 范围、等长评分和长度不匹配跳过，替换 cut_tail 前缀用例。
- `rollout.test.ts`：桩改读 `sources[]`；证明栏目来源未进入 Jev、同站文档得到有效回答及 test/on 一致。
- `sample.test.ts`：删除阶梯特有场景，保留实发、错型、缺答、失败、来源／片段映射和错误样本覆盖；更新唯一题库 hash 期望。
- `budget.test.ts`、`url.test.ts`：主要清理 FilterConfig 的退役字段，不改对应规则预期。
- `src/tools/llm_context/index.test.ts`：去掉为开关分支设置的环境和配置，改查默认新行为及宿主时间传递。
- `logging.test.ts`、`statusline.test.ts`：只在记录形状需要时调整；保留“未完成 Jev 检查”和 JSONL 无正文等原有验证。

## 7. 执行与验收顺序

1. 完成 A–F 的源码、测试、维护入口和文档修改；自查只修改本任务相关内容。
2. 先跑与变更直接相关的测试定位问题，再统一执行项目已有检查：

   ```bash
   npx tsc --noEmit
   npm test
   npm run format:check
   ```

3. 当前维护的 dev 依赖若被修改，显式运行对应测试。例如运行目录锁：

   ```bash
   node --test dev/full-context-run-lock.test.mjs
   ```

   运行实验费用工具测试和 demand 相关测试，用零网络桩验证旧 quality 不实发、独立比较接口和累计支出控制。

4. 源码检查通过、其他任务的构建边界已协调后，构建一次并运行零网络 stdio 冒烟：

   ```bash
   npm run build
   node --import tsx dev/smoke_stdio.ts
   ```

   `npm run build` 会重建 `dist/`；这一步属于后续实施，不在本轮写计划时执行。`smoke-rollout.ts` 的等价协议断言同步维护，按是否修改保留产物逻辑决定是否补跑，避免重复整套相同测试。

5. 用仓库外临时 cases 验证 full-context 的 `--plan` 和新 identity 离线回放；运行 compare 的支持路径及 dump 候选输出。
6. 做退役符号搜索和差异检查，确认没有遗留生产分支、失效 import 或第二套题库。测试数减少是删除退役行为的正常结果，不能以保持测试数量为目标。
7. 安装阶段才清理本机两个配置键并重启目标 MCP。若执行日常真实冒烟，只需检查一次实际共享请求、当前题目、版本标识和 v5 样本，不重新展开模型评测矩阵。

### 7.1 搜索验收

生产源码与当前维护入口中，以下退役标识应无可执行残留：

```text
JevSingleState / JevAllState / JevRequestMode / JevFallbackReason
AllBudgetEstimates / AllBudgetCheck / AllBudgetViolation / AllPlanResult / AllRequestPlan
JevLadderLevel / applyOversizeLadder
allBudgetEstimatesOf / checkAllBudget / ALL_LIMIT_32K / ALL_LIMIT_64K / ALL_TOKEN_MARGIN
planAllRequest / singleScoreInstructions / 旧 buildState / 旧 buildQuestions / 旧 SNIPPET_LEVELS
contextMode / temporalContext
single_candidate / over_budget / client_too_large / too_large
planned_estimates / single_limit_estimate / total_limit_estimate
cut_tail / source_only_questions / sent_snippets
```

`context_mode`、`temporal_context` 可留在“旧配置键已退役”的文档和兼容输入测试中，不能留作生效配置。通用英语 single、HTTP 单次尝试、来源题中的 single article、Brave 的 32768、顶层 off/test/on 不属于残留。

另查 `.source` 形状访问、`'source' in state` 和历史 request 原样传入 classify 的路径，包含被 `any` 绕过的 dev 调用。历史字段可保留在明确的离线读取中。

搜索包含忽略文件，按当前入口和冻结记录分类；仍被维护入口导入的旧依赖需要处理。

### 7.2 完成标准

生产仅保留全量 state、新题和一条编排路径；维护入口不再将旧请求交给生产分类器；v5 与 JSONL 的实发、回答和评分证据一致；工程与零网络端到端检查通过，源码和安装状态分别记录。
