# 局部维护性简化实施计划

> 注记（2026-10-03）：本文 §2 保留 `temporal_questions_sent` 的决策已被 2026-10-03 片段级时间题移除轮推翻，见 `TEMPORAL_REMOVAL_PLAN.md`。

日期：2026-10-02  
审查基线：`7234b80f0eaec548225c6f821ed7ea4faa5277f7`  
主要对应提交：`72a3ae0`（六题全量上下文）、`be7f7ea`（返回载荷精简）  
交接方式：另一个 AI 按本计划实施，完成后由原审查 AI 复审。

## 1. 目标与结论

减少已确认的重复计算、重复类型和无效接口成员，并按老大补充要求简化样本文件名。A–E 保持现有行为；F 只改变新样本文件名及引用该路径的文本，搜索结果、Jev 请求、预算降级、日志与样本的数据结构保持原样。

补充需求（2026-10-02）：现有 `201353-Xci6uxmXqQ.json` 的时分秒前缀与混合大小写不便辨认。样本已按日期分目录，日常每天大概率不超过 50 份，采用简短、统一小写的文件名即可。

本次属于小范围维护性清理。审查没有发现需要借此重写管道的结构性问题，也没有确认当前存在预算超限发送或错误过滤的问题。

实施前先读取仓库 `AGENTS.md`，检查当前差异。编写本计划时，工作区已有未跟踪文件 `TEMPORAL_QUESTION_LOADING_PLAN.md`；它属于其他工作，不修改、不删除、不纳入本次实现。若其他 AI 同时修改共享文件，保留其改动，仅在本计划范围内衔接。

## 2. 本次明确保留的设计

以下内容不纳入此次清理，实施时无需再次向老大询问是否删除：

| 保留项 | 理由 |
| --- | --- |
| `stats.jev.requests`、`FilterResult.jev_requests` 及现有摘要字段 | 请求摘要由完整记录自动投影；`on` 模式不写样本，JSONL 仍需独立记录请求与回退信息。 |
| `SampleJevSentSource.temporal_questions_sent` | 可以由原始记录推导，也方便人工复查；本轮不为少量字段改变落盘结构。 |
| `buildQuestions(number \| readonly string[])` 及历史开发脚本调用 | 生产调用正确；接口拆分属于单独的兼容性清理，不混入本轮。 |
| `dev/full-context-run-lock.mjs` 及测试 | 防止同一目录重复启动、并行认领和覆盖既有付费调用证据，单进程预算闸无法替代。 |
| single / all 共用的答案投影实现 | 继续保持同一裁决口径。 |
| 样本的 `in_state`、`score_question_sent`、`scored`、`score_applied` 等独立状态 | 各字段表达不同事实，实发证据继续按映射逐位核实。 |

不调整题干、过滤阈值、模式默认值、十步管道顺序、Brave 来源顺序、请求并发与重试逻辑。保持样本 `format_version`、过滤规则版本、题库版本和上下文布局版本不变；本计划不改变其对应语义。

## 3. 实施任务

### 任务 A：统一预算估算类型和身份映射类型

涉及文件：

- `src/filter/types.ts`
- `src/filter/jev/context.ts`
- `src/filter/sample.ts`

实施要求：

1. 将 `AllBudgetEstimates` 的唯一完整定义放入已有的 `types.ts`，保留五个字段、名称、类型与计算口径说明。
2. `JevRequestRecord.planned_estimates` 和 `SampleJevRequest.planned_estimates` 均引用该类型，删除两处内联字段清单。
3. `context.ts` 通过 `import type` 使用该类型；保留从 `context.ts` 导出该类型的现有入口，可使用一行类型重导出，避免无关导入路径迁移。
4. 将 `SampleJevRequestMappingEntry` 改为 `JevRequestMappingEntry` 的类型别名，保留现有导出名称；不再维护第二份字段定义。
5. 保持样本序列化和深拷贝代码不变。类型共用不代表可以删除样本构建时的复制操作。

验收：预算估算字段只完整定义一次，身份映射条目只完整定义一次；运行时不增加类型依赖，JSON 输出字段及其可选性不变。

### 任务 B：统一 single 阶梯与 all 的预算计算

涉及文件：`src/filter/jev/client.ts`、`src/filter/jev/context.ts`。

实施要求：

1. 客户端复用现有 `allBudgetEstimatesOf`、`ALL_LIMIT_32K` 和 `ALL_LIMIT_64K`。
2. 删除客户端的 `LADDER_LIMIT_32K`、`LADDER_LIMIT_64K`、`LADDER_TOKEN_MARGIN`，删除与共享函数重复的估算实现。
3. 阶梯的 32k 判定读取 `single_limit_estimate`，64k 判定读取 `total_limit_estimate`。
4. 保留现有常量值 `32000 / 64000 / 1.15`、浮点估算、严格大于才超限的边界。
5. 每次砍尾后，对更新后的 state 和题集重新估算；不能复用修改前的估算值。
6. 保留阶梯顺序：先处理 32k 砍尾，再处理 64k 去片段题，最后调用 `checkAllBudget` 同时复查两条限制。不能把砍尾循环条件替换成笼统的 `!checkAllBudget(...).ok`，否则会把 64k 超限也送进砍尾流程。
7. 砍尾时仍同步删除对应 `snip{i}` 和 `time_snip{i}`；来源题降级仍去除片段评分题与时间题，保持 `sentSnippets` 和 ladder 记账不变。
8. all 请求仍只做双限额检查，不进入 single 阶梯。
9. 移除客户端不再使用的 `estimateTokens` 导入，更新指向已删除常量的注释。

验收：相同输入得到相同的可发 / 拒发决定、阶梯级别、state、questions 和实际评分题数量；预算公式及参数只有一个维护来源。

无需新增预算模块、策略接口或缓存，也无需将现有 `ALL_*` 名称批量改名。

### 任务 C：删除样本写入失败后的重复 payload 计算

涉及文件：`src/tools/llm_context/index.ts`，以及 `src/filter/sample.ts` 的相关注释。

实施要求：

1. 将 `buildPayload` 包装函数与第一次调用合并为一次直接赋值：调用现有 `compactResponse(withAdjustments(filtered.result, raised))`。
2. 删除样本写入失败分支中的第二次 payload 赋值。
3. 完整保留状态行恢复逻辑：原本有状态行则恢复 `baseLine`，原本没有则删除 `stats.output.status_line`。
4. 保持先保存样本再返回的执行顺序。保存成功时，样本 `final_return` 与实际返回一致；保存失败时，实际第二个文本块及 JSONL 状态行不包含成功样本路径，日志仍记录保存失败。
5. 更新 `sample.ts` 文件头中“保存返回后剥离状态行并重建 payload”的旧说明，删除重建 payload 的表述，保留同步序列化与引用所有权说明。

验收：返回的第一块 JSON 和第二块状态行均与清理前一致；保存失败仍返回搜索内容，且不会声称样本已保存。

### 任务 D：清理答案投影的无效接口成员

涉及文件：

- `src/filter/jev/context.ts`
- `src/filter/jev/context.test.ts`
- `src/filter/pipeline.ts`

实施要求：

1. 从 `ProjectedSourceAnswers` 和返回对象中删除 `scoresComplete` 字段。
2. 保留函数内部的完整性判断，用于决定是否产生 `snippetScores`；局部变量可以继续叫 `scoresComplete`。
3. 从 `projectSourceAnswers` 入参类型、参数说明、生产调用和测试调用中删除未使用的 `nSnippets`。
4. 不删除调用方仍用于其他计算的同名局部变量。例如 all 分支仍需要候选片段数计算实际范围。
5. 删除测试中直接断言 `projected.scoresComplete` 的三处断言，保留对 `snippetScores` 内容或 `undefined` 的断言，以及逐题位置和有效性的断言。
6. 更新 `snippetScores` 的说明，直接解释何时有值，不再引用已经删除的返回字段。

语义注意：

- “整组评分答案齐全”与“每个评分值有效”是两件事。继续保持现有判断方式，不改成 `scoreValidity.every(Boolean)`，不顺带改越界值或非有限值的处理。
- `sentSnippets === 0` 时，当前行为是产生空 `snippetScores` 数组；不得顺手改为 `undefined`。
- 时间答案仍只在本地生成了该题且实际提交了该题时消费。
- 缺失的评分位置不压缩，后续评分不左移。

验收：single 与 all 的答案、逐题有效性、实收评分及最终裁决保持原样；调用方不再传无效参数，也不再接收冗余布尔值。

### 任务 E：修正候选收集函数的用途说明

涉及文件：`src/filter/pipeline.ts`。

将 `collectJevCandidatesDetailed` 注释中的“仅作内部 plain 版包装与候选口径核对备用”更新为当前用途，明确开发冒烟脚本也使用它构造带身份的候选并进行请求规划。

保留“样本层只信实发记录，不重建候选”的说明。`dev/full-context-smoke.mjs` 使用该函数不意味着生产样本层重新消费它。此任务仅改注释。

### 任务 F：样本文件名改为 8 位小写摘要

涉及文件：

- `src/filter/sample.ts`
- `src/filter/sample.test.ts`
- `src/tools/llm_context/index.test.ts`

命名约定：

```text
原：samples/2026-10-02/201353-Xci6uxmXqQ.json
新：samples/2026-10-02/a3c7f2d9.json
```

示例仅展示格式，不表示这两个摘要来自同一请求。新文件名固定为 `[0-9a-f]{8}.json`：去掉时分秒前缀及连接符，统一小写，只使用十六进制字符。

实施要求：

1. 继续以完整 `requestId` 为输入，复用现有 SHA-256 摘要，改为 `digest('hex').slice(0, 8)`。不直接截 UUID，不将 base64url 简单转小写，不新增随机数或短 ID 依赖。
2. 保留 `samples/YYYY-MM-DD/` 本地日期目录。`capturedAt` 仍只取一次，目录日期和样本内 `ts` 继续使用同一时间锚点；只删除文件名的时分秒拼接。
3. 完整 `request_id` 和 `ts` 继续保存在样本中，JSONL 的完整请求 ID 也保留。短摘要只用于文件命名，不替代请求身份。
4. 成功与错误样本均通过同一个 `allocatePath` 采用新规则。状态行绝对路径、JSONL 的 `sample.path` 相对路径及实际写入位置，继续使用同一个分配结果，不在调用方再次拼文件名。
5. 保留现有临时文件加 rename 的写入流程及失败处理，不增加目录扫描、每日序号、跨进程计数器、锁或碰撞重试框架。此处沿用摘要区分文件的概率性策略，不将它描述为绝对唯一或防覆盖保证。
6. 仅影响实施后的新样本。旧文件不改名、不搬迁；已有状态行和日志路径仍然有效，新旧格式可以同目录共存。
7. 更新文件头、`AllocatedSamplePath.relative` 说明、分配逻辑注释和相关测试中旧命名格式的描述。同步修正“文件名等于完整 request_id”这类已不准确的相关注释。
8. 更新 `sample.test.ts` 与适配层 `index.test.ts` 的文件名 / 相对路径断言；复用现有成功、错误、相对日志目录和并发请求测试，继续确认每个返回路径对应自己的真实样本。

规模依据：8 位十六进制有 `16^8 = 4,294,967,296` 种名称。假设不同请求的摘要均匀分布，一天 50 份样本中任意两份同名的概率约为 **0.000028522%**（约 351 万分之一）。这是按每日独立目录计算的概率；本次依据老大的实际规模接受这一取舍，不额外建设冲突协调机制。

验收：所有新成功 / 错误样本文件名都符合约定且无时间前缀、大写字母或连接符；目录日期、记录时间、完整请求 ID、样本内容及路径引用关系保持正确。文件名不再承担按时间排序的用途，需要时间时读取 `ts`。

## 4. 文件范围与执行顺序

按 A → B → C → D → E → F 执行即可，无需子代理并行。

预计修改以下九个实现或测试文件：

| 文件 | 允许的变化 |
| --- | --- |
| `src/filter/types.ts` | 统一预算估算类型，请求记录引用共享类型 |
| `src/filter/jev/context.ts` | 引用及重导出类型、清理投影接口、更新注释 |
| `src/filter/jev/client.ts` | 复用预算计算、移除重复常量和无用导入 |
| `src/filter/sample.ts` | 复用类型、修正所有权说明、简化样本文件名 |
| `src/tools/llm_context/index.ts` | payload 只构建一次 |
| `src/filter/pipeline.ts` | 删除无效实参、修正候选函数注释 |
| `src/filter/jev/context.test.ts` | 更新投影调用和冗余断言，保留行为覆盖 |
| `src/filter/sample.test.ts` | 更新样本文件名与路径断言，保留现有落盘验证 |
| `src/tools/llm_context/index.test.ts` | 更新成功 / 错误样本命名断言，保持路径和返回一致性验证 |

只有出现直接相关的验证缺口时，才扩展现有 `client.test.ts` 或增加现有测试文件中的用例。不进行全仓格式化、不改开发脚本、不重录夹具、不更新依赖。

若实施中发现新的行为缺陷，单独记录触发条件与证据，避免扩展到 A–F 之外。

## 5. 验证与交付

### 已核实的审查基线

- `npx tsc --noEmit`：通过。
- `npm test`：988 项通过，无失败、跳过或取消。
- `node --test dev/full-context-run-lock.test.mjs`：另有 7 项通过，不包含在上述 988 项内。

以上为本计划编写前同一会话的实测结果。接手 AI 应记录自己的起始提交与工作区状态，完成修改后重新执行必要验证。

### 实施后必须完成

1. 对本次变动的 TypeScript 文件执行 Prettier 检查，必要时只格式化这些文件。
2. 执行 `npx tsc --noEmit`。
3. 执行 `npm test`，保留现有行为测试。删除三条冗余断言和更新命名断言不应减少测试用例数量；数量变化须说明原因。
4. 执行 `git diff --check`，审阅差异是否仅包含计划范围。

验证重点复用现有测试，不为类型别名或删除重复表达式额外增加镜像测试：

- 双限额边界、single 阶梯砍尾及相关时间题同步移除、all 超限路径。
- single / all 投影、缺答和错误类型、评分位置、未发送时间题不被消费。
- 样本保存成功和失败，尤其失败时原本有 / 无状态行的两条分支。
- 新命名同时覆盖成功与错误样本；相对 / 绝对路径正确，并发请求各自返回对应样本。
- 样本、JSONL 和实际返回字段保持不变；F 允许其中的样本路径值按新命名变化，完整请求 ID 与时间不变。

本次不改变目录锁，无需重复运行其测试；不需要真实 Brave / Jev 请求、付费冒烟、重录样本或性能评测。

### 交给复审 AI 的材料

完成后提供：

- 起始与结束提交；若未提交，说明改动仍在工作区并列出修改文件。
- A–F 六项完成情况，以及任何偏离计划的地方。
- 实际执行的检查、退出状态和测试汇总。
- 需要复审关注的异常或尚未解决的问题；没有则明确说明。

复审按“A–E 行为等价、F 命名符合约定且路径一致、接口确实变小、重复维护确实减少、保留项未被误删”逐项检查。实施完成后交回审查，不扩展到发布、合并或其他清理任务。
