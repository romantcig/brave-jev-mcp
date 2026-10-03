# 片段级时间题机制移除实施计划（time_snip{i} 整块退役）

日期：2026-10-03。状态：**审查通过（有条件通过），阻塞项与建议已吸收进本方案；已派实施**。本文不是已实施报告。

工作区基线：git HEAD `326c8a9`，src/ 下 18 文件（src/filter 17 个 + `src/tools/llm_context/index.test.ts`）含上轮"来源级题精简（filter-rules-11）"的**未提交改动**。行号一律以当前工作区状态为准，实施前核对。本方案与上轮改动**同工作区叠加**，实施时不回退、不提交上轮改动（提交时机由老大统一决定）。

决策依据：老大 2026-10-03 拍板删除片段级时间题机制，不做按需加载。数据：日常 29 次搜索发出 117 道时间题仅 1 次触发删除（Cloudflare 公共 CA 片段 0.86）；77 份 test 样本口径 45 道、0 道过线。机理：日常查询都是"现在怎么样"，Brave 返回也是近期内容，片段里的四位数字几乎全是版本号、CVE 编号、版权年份，"时期错位"这一假想敌在日常分布中不存在。

探索依据：全仓调用链探索报告（2026-10-03，随本方案移交）。

## 1. 本轮决策

**整块移除片段级时间题机制：题目构造条件、题干模板、时间门槛常量、裁决消费、投影防御、砍尾连带删题、样本记账字段，全部删除。片段评分题（snip{i}）与来源级四题零改动。**

探索报告的 10 个待定夺问题，定案如下：

1. **`buildQuestions` 签名保留，只删时间分支**：删分支后"数量形式"与"正文形式"产出完全一致（4 道来源题 + N 道 snip 题），但按 `MAINTENANCE_SIMPLIFICATION_PLAN.md` §2 的既有决策（"接口拆分属于单独的兼容性清理，不混入本轮"）不做签名合并，历史回放调用方零影响。补一条**两形式 deepEqual 一致性守卫**锁住这个性质。
2. **`projectSourceAnswers` 三个时间参数全删**（`sentStateSnippetCount`、`localQuestionAt`、`sentQuestionAt`）：grep 确认生产/test 外无调用方；死参数比硬签名变更更误导。pipeline 两处调用点的实参计算（all 路约 L801-812、single 路约 L950-961）同轮收缩。`snippetCountOfState` 函数本体**保留**（sample.ts 仍在消费），仅撤除 pipeline 侧对该函数的 import（若撤除后无其他消费）。
3. **`SnippetRemovalReason` 保留 `'time_mismatch'` 成员 + 退役注记**：照上轮 `SourceDropReason` 保留退役成员的先例。历史样本与 JSONL 中有真实 time_mismatch 记录（日常唯一命中、第十四轮录制），旧记录的 `snippets[].reason` 回显需要类型覆盖。statusline 不回显片段 reason，无行为分支。
4. **`FILTER_RULES_VERSION` 递增为 `filter-rules-12`**：删除一道生效的片段删除规则是过滤决策语义变化，符合 version.ts 内递增纪律原文（"凡改变过滤决策语义的改动……必须递增"）；上轮删两道来源门槛递增为先例。
5. **`dev/stub_fetch.mjs` 本轮最小修复**：删 L1 对 `hasExplicitYear`、`temporalQuestionText` 的两个具名 import、L200-209 的时间题校验段（含 L200 注释行——L205 起的 for 循环延伸到 L209、循环体内有合成零值注入，只删到 L207 会留下孤儿语句与悬空花括号）、L148 过滤子句的 time_snip 分支（`!/^(?:snip|time_snip)\d+$/` 简化为 `!/^snip\d+$/`，删机制后该键永不出现，行为等价，不简化会留静默残留），**其余十题逐字校验等历史断言一概不动**。理由：这是模块加载级崩溃（build 重建 dist 后跑冒烟即 import 失败），不是上轮"已知基线失败不动"先例所覆盖的断言失败；冒烟是日常验证入口，留着必然炸。此为对上轮"dev/ 全部不动"决策 6 的**显式豁免**，豁免范围仅此三处。
6. **pipeline.test 的 'ignores extra answers for questions that were never asked' 用例改写保留**：extra 答案里塞入退役来源题旧键（stale / self_deprecated，照 sample.test 的 legacy-extra-answer 模式）**及** `s0__time_snip0` 高概率时间答案，断言全部不消费——一条用例同时守住两轮退役机制的负空间。
7. **守卫补充以两条为限**：questions.test 补"正文形式 === 数量形式 deepEqual"守卫（决策 1）；pipeline 的 extra-answers 用例改写含时间键（决策 6）。**不再**加"年份片段 + 塞回时间答案不删除"的端到端镜像用例——extra-answers 用例已覆盖该负空间，避免覆盖冗余（照维护轮"不为删除的表达式增加镜像测试"的既有哲学）。
8. **两份未跟踪方案文档加一行注记**：`TEMPORAL_QUESTION_LOADING_PLAN.md` 文首加"2026-10-03 片段级时间题机制已整体移除，本方案作废，保留为当时基线快照"（其状态行"待实施"已永久失真，留注记防误实施——上轮"提案不改"的前提"将来可能推进"已被老大决策否定）；`MAINTENANCE_SIMPLIFICATION_PLAN.md` 文首加一行"其 §2 保留 temporal_questions_sent 的决策已被 2026-10-03 时间题移除轮推翻，见 TEMPORAL_REMOVAL_PLAN.md"（防未来实施者拿旧方案与新代码对质）。
9. **filter-notes.md 记已知行为回退一条**：日常唯一一次 time_mismatch 删除（Cloudflare 公共 CA 片段）今后将由过滤保留，便于日后样本审查归因。
10. **测试基线变化说明**：预计净减 5–8 个用例（temporal.test.ts 整文件 3 个 + pipeline T04 时间路由 1 个 + context 投影时间用例 1 个 + questions 时间构造 2 个），实施报告须对照起始基线逐项说明。决策 1 的 deepEqual 守卫是净增；决策 6 的 extra-answers 用例是**改写**既有用例，非净增。按审查核算：questions.test 删 2 增 1，全轮净减约 6 条（在 5–8 区间内），以实施实测为准。

## 2. 实施范围与不变量

1. **片段评分全套零改动**：snip{i} 题构造、三档 legend、`snippetMin = 1.0` 严格小于才删、`isUsableSnippetScore` 校验、逐位对齐与砍尾前缀语义。`applySnippetScores` 删时间分支后循环体退化为纯 score 判定；score 分支末尾的 `continue` 删时间分支后变冗余，**保留不动**（无害，verdict.test 七个 score 用例锁行为，不做风格性简化）。
2. **来源级四题与三门槛（off_topic → listing → filler）零改动**；上轮的裁决校验块（四键全 usable 否则 keep + validation）零改动。
3. **十步管道顺序不变**：`applySourceVerdicts → applySnippetScores → applyNovelty → dropEmptySources`。时间删除删光片段后由步 8 按 empty 归因，novelty 与时间题零耦合（只读 has_original_reasoning），无连带。
4. **预算机制与请求组织不变**：single 阶梯、all 双限额预检、回退路径的记账（ladder 值、`sent_snippets`）不变——`sentSnippets` 只数 `/^snip\d+$/` 键，时间题从来不在口径内。
5. **独立年份正则禁改**：`src/filter/prefilter.ts` 的 `REFERENCE_ITEM_YEAR_END`（步 3 引用块剥离签名）与时间题机制无关，**绝不可顺手删**。
6. **config / logging / statusline / stats / novelty 零改动**：`TEMPORAL_SNIPPET_DROP` 是不可配置的编译期常量，不在 `DEFAULT_THRESHOLDS` / `THRESHOLD_SPECS` / 阈值快照里；statusline 只回显来源级 reason；stats 无时间计数器。
7. **样本 format_version 保持 4**：题库变化只动 `QUESTION_SET_ID`（哈希配方 5 元素收缩为 3 元素，值自动变化）。`temporal_questions_sent` 字段删除后旧样本有、新样本无——按 v4 可选字段惯例与上轮 thresholds 键集收缩先例处理。
8. **fixtures / 历史 notes / dev/（除决策 5 豁免的 stub_fetch 三处）零改动**：两份 `.jev.json` 录制 grep 证实无 time_snip（时间题是请求时按片段生成、从未进录制顶层）；round-13/14 等历史实验记录不改写。

## 3. 实施任务

行号以当前工作区为准（含上轮未提交改动），实施前核对。

### 任务 1：`src/filter/jev/questions.ts`

1. 删除五个导出：`EXPLICIT_YEAR_PATTERN`、`hasExplicitYear`、`TEMPORAL_SNIPPET_DROP`、`TEMPORAL_SNIPPET_INSTRUCTION`、`temporalQuestionText`（约 L60-69）。
2. `QUESTION_SET_ID` 哈希输入数组从 5 元素收缩为 3 元素（`[GLOBAL_INSTRUCTION, SOURCE_QUESTIONS, SNIPPET_LEVELS]`），注释同步。
3. `buildQuestions` 删除时间题分支（约 L159-161），签名不动（决策 1）；docstring"传正文时，带年份片段另有时间题""数量形式仅省略年份题分支"等表述同步。
4. 文件头注释同步（时间题常量退场记载 + 本轮决策依据一句话）。

### 任务 2：`src/filter/jev/verdict.ts`

1. `applySnippetScores` 删除时间删除分支（约 L203-211：取 time_snip 概率、`>= TEMPORAL_SNIPPET_DROP && hasExplicitYear(...)` 双条件、`reason='time_mismatch'`），评分删除语义逐字保持，score 分支末尾 `continue` 保留（不变量 1）。
2. import 收缩：`hasExplicitYear`、`TEMPORAL_SNIPPET_DROP` 移除，仅剩 `SNIPPET_LEVELS`。
3. 函数 docstring 与文件头的"时间判断"表述收缩为"片段 score 删除"。

### 任务 3：`src/filter/jev/context.ts`

1. `projectSourceAnswers` 删除时间投影段（约 L245-254）与三个时间参数（`sentStateSnippetCount`、`localQuestionAt`、`sentQuestionAt`），docstring 同步收缩。
2. `snippetCountOfState` 函数本体保留（sample.ts 消费），仅当 pipeline 侧 import 撤除后无其他 src 消费时，其注释可标注主要消费方；函数导出本身不动。
3. 文件头与 `ProjectedSourceAnswers.answers` 注释去时间表述。

### 任务 4：`src/filter/jev/client.ts`

1. `applyOversizeLadder` 砍尾循环删除 `delete workQuestions['time_snip'+snippets.length]` 一行（约 L314）。
2. source_only_questions 过滤谓词删除 `/^time_snip\d+$/` 子句（约 L323）。
3. 阶梯注释（② ③ 级描述、文件头）同步；`sentSnippets` 记账与 ladder 语义不动（不变量 4）。

### 任务 5：`src/filter/pipeline.ts`

1. all 路（约 L801-812）与 single 路（约 L950-961）两处 `projectSourceAnswers` 调用点实参收缩：删除 `sentStateSnippetCount` 计算、`localQuestionAt` / `sentQuestionAt` 闭包及相关中间量。三参数删除后变死的中间量须删净：all 路 L796 `sentQuestions`、L797 `sentState`、single 路 L948 `sentQuestions`——tsconfig 未开 noUnusedLocals，tsc 不会报未使用局部变量，须对照消费关系手动确认。
2. `snippetCountOfState` 的 import 若因此无消费则撤除（函数本体留在 context.ts，决策 2）。
3. 上轮刚改过的 L1722-1724 题数断言（11）不受影响——其 payload 片段无年份，保留核对即可。

### 任务 6：`src/filter/types.ts` 与 `src/filter/sample.ts`

1. types.ts：`question_keys` 注释去 `time_snip{i}`（约 L317）；`SnippetRemovalReason` 保留 `'time_mismatch'` + 退役注记（约 L470，照 `SourceDropReason` 先例措辞）。
2. sample.ts：删除 `SampleJevSentSource.temporal_questions_sent` 类型字段（约 L221-222）、`buildJevSection` 的 `temporalKeys` 计算与条件 spread（约 L495-504、L518）。该字段全仓零读取方，删除零读取风险；此决策显式推翻 `MAINTENANCE_SIMPLIFICATION_PLAN.md` §2 的"保留"（决策 8 已留痕）。

### 任务 7：`src/filter/version.ts`

`FILTER_RULES_VERSION` 改为 `'filter-rules-12'`，块注释新增一行说明（删除片段级时间题机制，117 问 1 中、45 问 0 中的样本依据）；版本史里的"4 = 带年份片段的时间判断"等历史行**不改写**。

### 任务 8：`dev/stub_fetch.mjs`（决策 5 豁免，仅此两处）

1. 删 L1 对 `hasExplicitYear`、`temporalQuestionText` 的具名 import（改为无导入或保留原有其他导入结构）。
2. 删 L200-209 的时间题校验段——含 L200 注释行；L205 起的 for 循环延伸到 L209，循环体内的合成零值注入必须随循环一起删，只删到 L207 会留下孤儿语句与悬空花括号（.mjs 不在 tsconfig include，tsc 与 npm test 都查不出，冒烟一启动即 SyntaxError）。
3. L148 的过滤子句 `!/^(?:snip|time_snip)\d+$/` 简化为 `!/^snip\d+$/`（行为等价，避免静默残留）。
4. 其余全部断言（v3 十题校验等）不动；文件头注释如有时间题表述一并核对。

### 任务 9：测试改写（原则：覆盖不减，新增守卫以决策 7 两条为限）

| 文件 | 改动 |
|---|---|
| `src/filter/temporal.test.ts` | **整文件删除**（3 用例：时间删除全链路、缺答/非法/未实发保留、失败不用时间判定） |
| `src/filter/jev/questions.test.ts` | 删"only asks temporal questions for a standalone year"与题数公式含带年份项的用例（删 2 增 1：原 9 = buildQuestions 7 + buildState 2，删 2 后增 deepEqual 守卫，9→8）；数量形式用例（`buildQuestions(3)===7`、`buildQuestions(0)===4`）**保留**（删后 4+N 公式仍成立）；**新增**"正文形式 deepEqual 数量形式"守卫（决策 1） |
| `src/filter/jev/verdict.test.ts` | **零改动**（applySnippetScores 七用例全为 score 语义，无时间用例） |
| `src/filter/jev/context.test.ts` | 命名空间用例删时间断言（s7__time_snip0 有/无、时间题干转换），保留命名空间与 snip/来源题干转换断言；`projectSourceAnswers` 块删时间断言（T04 映射 time_snip1:0.9、single 恒等 time_snip1）与 'never sent temporal' 整用例；三参数签名收缩后全部用例实参同步；'local question set byte-equal' 用例两侧同变应自然通过，核对 |
| `src/filter/jev/client.test.ts` | cut_tail 用例删 `time_snip4` 不在实发题集的一行断言（约 L1142），砍尾删 snip4 断言保留；source_only_questions 用例（500 片段含 2024 → 500 道时间题）删机制后题数断言 4 仍成立，场景含义变为纯 snip 题，**核对后保留**，注释同步 |
| `src/filter/pipeline.test.ts` | 删 T04 'routes temporal answers per source' 整用例（约 L1837-1892）；'ignores extra answers' 用例改写（决策 6：extra 塞退役来源题键 + time_snip 键，断言不消费） |
| `src/filter/sample.test.ts` | `QUESTION_SET_ID` 配方镜像测试收缩为 3 元素（import 同步收缩）；'missing-source-answer' 与 'legacy-extra-answer' 场景不受影响（核对） |
| `src/filter/config.test.ts`、`logging*`、`statusline*`、`novelty*`、`pipeline.fixtures.test.ts`、`src/tools/llm_context/index.test.ts` | 零改动（时间门槛不可配置；fixtures 回放是 off 模式） |

### 任务 10：文档

**更新（当前状态类）：**

- `filter-notes.md`：L17"已采用"句（片段正文含年份时追加时间题）改为退役表述；"时间题按需加载探索（2026-10-02）"小节加去向注记（机制已整体移除，探索作废）；源码基线行更新（filter-rules-12、新题库 ID 实际值）；已知行为回退一条（决策 9）。
- `notes/jev-question-writing.md`：经核对无时间题章节（探索确认），仅在退役记录处照 self_deprecated/stale 先例补一笔时间题退役。
- 根目录 `TEMPORAL_QUESTION_LOADING_PLAN.md`、`MAINTENANCE_SIMPLIFICATION_PLAN.md`：各加一行文首注记（决策 8）。
- `AGENTS.md`、`notes/staleness.md`、`PLAN.md`：经核对无时间题必改项，不动。
- `notes/test-mode-logging.md`：实施时核对是否残留上轮应清的过时表述（如 stale_drop、十题计数）——若残留属上轮遗漏，顺带修正并在实施报告说明；无残留则不动。

**不改（历史记录/快照）：** notes/ 各实验轮记录（round-13/14/20/21/22/24 等）、decisions-log.md、filter-features.md、private-jev-evidence.md、temporal-question-demand-loading.md、fixtures/ 全部、dev/ 其余全部。

## 4. 验证

门禁：`npx tsc --noEmit`、`npm test`、对改动文件跑 prettier 检查、`git diff --check`，外加 `node --check dev/stub_fetch.mjs`（纯语法解析零副作用——.mjs 不在 tsconfig include，其余门禁都不覆盖它，专门守住 stub 修复不留孤儿语句）。先查明现存失败，不把历史问题伪装为本轮通过。**tsc 是三参数签名收缩的唯一自动闸**（tsx 运行时不查类型），必须先过 tsc 再跑测试。

重点回归：

1. 投影签名收缩后 single / all 两路答案、逐题有效性、评分齐全语义与改前逐字一致（context.test 既有 score 用例全过）。
2. `applySnippetScores` 纯 score 行为：verdict.test 七用例原样通过；时间负空间由改写后的 extra-answers 用例（含 time_snip 键不消费）守住。
3. `buildQuestions` 两形式 deepEqual 守卫通过；数量形式题数 4+N 用例通过。
4. 砍尾 / source_only 阶梯用例通过（题数断言按新公式核对）。
5. `QUESTION_SET_ID` 配方镜像（3 元素）自动重算通过；`filter-rules-12` 写入样本与 JSONL。
6. 上轮场景不受影响：missing-source-answer（is_listing 缺答 → validation）、legacy-extra-answer（退役来源题旧键忽略）。
7. 旧样本含 `temporal_questions_sent` 字段、新样本不含：格式层面确认序列化路径无残留引用。
8. dev 基线：除 stub_fetch 三处豁免修复外，dev 零改动；不在 smoke 系加新断言。

## 5. 交付与审查检查表

- 提交可审阅差异 + 实施报告：任务 1–10 对照、测试数量变化逐项说明、实施后实际 `QUESTION_SET_ID` 与 `filter-rules-12`、门禁输出。
- 审查重点：
  1. `applySnippetScores` 评分删除语义逐字保持（含等号、保守保留、对齐、continue 保留）；
  2. 投影三参数全删且两处调用点无残留、`snippetCountOfState` 本体保留；
  3. `temporal_questions_sent` 写入路径删净且类型字段同步；
  4. `SnippetRemovalReason` 保留 `'time_mismatch'` + 注记、prefilter 年份正则未动；
  5. stub_fetch 豁免仅限三处（L1 import、时间校验段 L200-209、L148 正则子句简化）；
  6. 守卫新增以两条为限、负空间覆盖到位（extra-answers 含 time 键）；
  7. 文档当前状态类更新、历史零改写、两份方案文档注记到位；
  8. 时间题相关代码零残留（src 全仓 grep `time_snip` / `temporal` / `hasExplicitYear` / `TEMPORAL_`，仅剩 `SnippetRemovalReason` 退役成员与版本史注释）。已知 grep 误报：`src/filter/jev/novelty.test.ts` 的英文测试数据 "nothing temporal in this prose" 属数据文本不是代码，不算残留，不得修改。
- 回退：使用本方案实施前的代码版本重新构建；样本、JSONL 与日志保留，不删证据。
