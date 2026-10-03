# 来源级题精简实施计划（删除 stale 与 self_deprecated）

日期：2026-10-03。状态：**方案待审查；审完派实施**。本文不是已实施报告。

审查基线：`326c8a9`（预算估算类型收敛与样本文件名精简提交）。实施前核对实际基线与行号，保留其他工作，不覆盖他人改动。

探索依据：全仓调用链探索报告（2026-10-03，随本方案移交）。样本依据：77 份 test 样本、386 次来源裁决统计——stale **零触发**（历史最高 0.76，门槛 0.85，386 次提问从未达到）；self_deprecated **触发 5 次、4 次明确误删**（报道弃用事件的文章被误判为页面自我声明弃用；同页其他题一致判原创 0.79–0.89、切题 0.03–0.13，唯独 self_deprecated 删除）；来源级删除全部实际产出 10 次 = is_template_filler 5 次（全部正确：插件农场页、版本发布页、npm 包页）+ self_deprecated 5 次（4 误删 1 存疑）。

误删机理：self_deprecated 题干四个条件（deprecated / archived / superseded / no longer maintained）与"报道弃用事件"的内容天然撞车——页面叙述"某 API 已弃用"即被当作"本页自称弃用"。搜索主题涉及政策变化时一搜必触发。

结构动机：题目模板 token 占请求总体约 70%，题目花费超过来源内容。删除两道**必发**来源题，六题变四题，每次请求的来源题固定开销减三分之一。

## 1. 本轮决策

**删除来源级题 stale 与 self_deprecated，六题变四题。不做按需加载。时间题（time_snip{i}）本轮不动。**

探索报告提出的 8 个待定问题，定案如下：

1. **阈值彻底删除**：`DEFAULT_THRESHOLDS`、`JevThresholds`、`THRESHOLD_SPECS` 三处的 `selfDeprecated` / `staleDrop` 同步删除，不保留死配置。解析器对 thresholds 内未知键静默忽略的行为已被 `config.test.ts` 现有测试锁定（"ignores unknown keys inside thresholds"），旧配置文件无需迁移、不报错。
2. **`SourceDropReason` 保留两个退役成员**：`'self_deprecated'` 与 `'stale'` 留在 union 里，statusline 的 stale 逐源回显分支及其测试**全部保留**，注释标注"已退役，仅为历史样本记录保留"（先例：`ShadowDiff` / `WouldActionEvidence` 仅为读旧记录保留）。理由：历史 JSONL/样本中 self_deprecated 有 5 次真实 drop 记录，类型与回显需能消费历史记录形状；diff 最小、审查面最小。死分支清理留给后续维护轮，本轮不扩 scope。
3. **`FILTER_RULES_VERSION` 递增为 `filter-rules-11`**：删除两个生效门槛是裁决语义变化（gates 五道变三道），不只是题干变化。依据先例 `bf347a8`（六题精简时 rules-4→5，当时理由同为裁决语义变化）。`version.ts` 中文注释同步说明。
4. **`QUESTION_SET_ID` 不改代码、随 `SOURCE_QUESTIONS` 自动变化**——预期行为，"配方镜像"测试从常量重算自动通过；已确认无硬编码具体哈希值的测试断言。
5. **样本 format_version 保持 4**：先例是题库变化只动 question_set_id 不动 format_version。
6. **dev/ 全部不动**：`smoke_stdio.ts` / `smoke-rollout.ts` / `stub_fetch.mjs` 的旧十题录制断言自六题精简起就是已知基线失败，不得在本轮"顺手修"；`filter-experiments.ts` / `filter-round15-content.ts` 的 question_set_id 相等守卫按设计拒绝旧录制（防旧回答冒充新题）；`compare_probe_flips.py` 硬编码键清单属历史分析工具。将来复用时再改。
7. **文档分级处理**：当前状态类更新（jev-question-writing.md、filter-notes.md、AGENTS.md、test-mode-logging.md）；历史类不改写（staleness.md 仅文首加一行退役注记）；PLAN.md 加注记不改写历史设计段落；**两个未入库提案（TEMPORAL_QUESTION_LOADING_PLAN.md、CONTEXTUAL_FILTERING_PROPOSAL.md）不改**——它们是调查基线 `7234b80` 的快照，若将来推进时间题方案需按新基线重新对账，届时一并修订。
8. **已知行为回退记录**：filter-notes.md 当前状态记一条——历史上唯一一次可能非误删的 self_deprecated 触发（`github.com/mrexodia/ida-pro-mcp` 仓库主页）类来源今后将由过滤保留；真弃用归档页改由 is_template_filler、片段评分与去重兜底。便于日后样本审查归因。

## 2. 实施范围与不变量

本轮删除两道来源级题及其两个门槛常量。以下保持：

1. **十步管道顺序不变**。幸存三门槛 off_topic(0.85) → listing(0.8) → filler(0.8) 的相对顺序、概率 ≥ 门槛含等号即丢、命中即停取首因的语义不变。
2. **has_original_reasoning 两处保护行为不变**——已确认模板删除豁免（verdict.ts，只读 `has_original_reasoning` 与 `reasoningProtect`）与指纹新颖度免删（novelty.ts `reasoningProtected`）的实现**均不读取**这两题答案，删除后保护逻辑零改动。
3. **CJK 加成通用逻辑不变**：bonus 逐门槛通用消费，随 gates 数组缩短自动生效，无按题名列举的代码。
4. **缺答保守语义不变**：裁决必需概率缺失或越界 → 整来源 keep + `fail_kind='validation'`。**裁决校验块必须同步从六键收缩为四键**（最高风险，见任务 2）——删题后答案投影不再产出这两个键，漏改校验块会使每个 answered 来源都走 validation 兜底，来源级过滤整体静默失效，状态行大量出现未检查计数。
5. **时间题链条不动**：构造条件（正文带年份）、0.85 门槛、"本地构造且实发才消费"的防御、砍尾连带删题规则，全部原样。
6. **请求组织与投影不变**：single / all / 回退共用同一裁决实现；答案投影按 `SOURCE_QUESTIONS` 键集自动收缩到四键；样本 v4 结构不变。
7. **off / test / on 共用同一裁决实现**，三档行为一致。

本轮不做：不调任何保留题的题干与门槛、不动片段评分题与时间题、不改请求组织与预算逻辑（预算估算机制的去留是另一项独立决策，本轮不碰）、不动十步顺序。

## 3. 实施任务

行号以 `326c8a9` 为准，实施前核对。

### 任务 1：`src/filter/jev/questions.ts`

1. `SOURCE_QUESTIONS` 删除 `self_deprecated`、`stale` 两个键值对，剩四键（相对顺序保持：has_original_reasoning、is_template_filler、is_off_topic、is_listing）。
2. `DEFAULT_THRESHOLDS` 删除 `selfDeprecated: 0.7`、`staleDrop: 0.85`，十一项变九项。
3. 注释同步：文件头（"六题精简版"→ 四题，追加本轮精简的日期、样本统计与决策依据）；`SOURCE_QUESTIONS` 上方注释（"五道进丢弃门槛"→"三道"）；`DEFAULT_THRESHOLDS` 上方注释（十一项→九项、五道→三道）；`buildQuestions` docstring（题数公式 6+N+带年份 → 4+N+带年份，example `buildQuestions(3)` 结果 9 → 7）。

### 任务 2：`src/filter/jev/verdict.ts`（最高风险任务）

1. 删除 `pSelfDeprecated` / `pStale` 概率提取。
2. **裁决校验块从六键收缩为四键**：仍要求四道概率全部 usable（有限且在 [0,1]），任一缺失/越界 → 整来源 keep + `fail_kind='validation'`，保守语义逐字保持。
3. gates 数组删除 self_deprecated、stale 两项，门槛顺序变为 off_topic → listing → filler。
4. 注释同步：文件头（裁决顺序、四题表述）。

### 任务 3：`src/filter/config.ts`

`THRESHOLD_SPECS` 删除 `selfDeprecated`、`staleDrop` 两行。未知键静默忽略是现有行为，不加新逻辑。注释同步：`THRESHOLD_SPECS` 上方 docstring 的"十一项阈值……六个概率门槛（五道丢弃 + reasoning 保护）"改为九项、四个门槛（三道丢弃 + reasoning 保护）。

### 任务 4：`src/filter/types.ts`

1. `JevThresholds` 删除 `selfDeprecated`、`staleDrop` 成员。
2. `SourceDropReason` **保留** `'self_deprecated'` 与 `'stale'` 成员，加注释标注退役原因（决策 2）。
3. 注释同步：`JevPerSourceStats.answers` 注释、其余"六题/六道关键题/局部题键"表述，以及 L48、L232 附近的"十一项 Jev 阈值"→ 九项。

### 任务 5：`src/filter/version.ts`

`FILTER_RULES_VERSION` 改为 `'filter-rules-11'`，中文注释说明本轮：删除来源级 stale 与 self_deprecated 两道门槛题（样本统计依据见方案）。注释格式：该文件历史版本说明在文件内块注释中逐版列出，rules-10 的说明单列一行——实施时把 10 的说明并入块注释、新增 11 的说明，保持格式一致。

### 任务 6：仅注释更新

- `src/filter/pipeline.ts`（"六题全量上下文"等表述、"per_source 记六题概率"）。
- `src/filter/jev/context.ts`（`projectSourceAnswers` 相关"六题"注释）。
- `src/filter/sample.ts`（"实际裁决所需的六道题通过校验"→ 四道；`SampleConfigSnapshot.thresholds` 注释"十一项生效阈值"→ 九项）。
- `src/filter/logging.ts`（文件头与 `thresholdSnapshot` 附近"十一项"快照表述→ 九项）。
- `src/filter/statusline.ts`：文件头 D-03 表述与 stale 逐源回显分支（约 L12-13、L54-64）加"已退役，仅为历史样本记录保留"标注——决策 2 的落地动作，**分支与测试零改动**。

### 任务 7：测试改写（原则：覆盖不减）

审查已确认：off_topic / listing / filler 三个保留门槛**各自都已有"恰好等于门槛即丢"的边界用例**（verdict.test.ts 的 off_topic 双向用例、listing、filler 用例），删除两个退役边界用例后含等号语义的覆盖不减，**无需迁移**。

| 文件 | 改动 |
|---|---|
| `src/filter/jev/verdict.test.ts` | `ZERO_ANSWERS` 六键→四键；删除两个退役边界用例（self_deprecated 恰 0.70、stale 恰 0.85）；"五道门槛概率全部低于线"用例改写为三门槛；注释同步（"固定顺序五道丢弃门槛"、"裁决链只读六键"等） |
| `src/filter/jev/questions.test.ts` | 文件头"六键齐全（2026-10-01 精简后）"注释同步；六键 deepEqual→四键（测试名同步本轮）；`DEFAULT_THRESHOLDS` 十一项→九项；buildQuestions 题数 9/6/11 → 7/4/9。**注意：`V3_HISTORICAL_KEYS`（含两题键名）是对历史夹具 JSON 的结构验证，保留不动，勿误改** |
| `src/filter/jev/client.test.ts` | **硬编码题数断言两处**：'carries six source-level questions plus one per snippet' 用例（测试名含 "six" 同步改）题数 9→7；另一处 2 片段 state 的题数断言 8→6 |
| `src/filter/pipeline.test.ts` | **硬编码题数断言三处**（describe "six-question all-context request organization" 的 T04 用例）：s0/s1 局部题数注释"八道/七道"→"六道/五道"；三处断言 15→11、8→6、7→5 |
| `src/filter/config.test.ts` | 默认值 verbatim 十一项→九项；boundary values 用例删两键；坏值用例（现用 `stale_drop: -0.1`）换用保留键 |
| `src/filter/sample.test.ts` | `missing-source-answer` 场景 `delete answers.stale` → `delete answers.is_listing`（stale 不再是必需键，场景必须仍触发 validation 防御）；`legacy-extra-answer` 断言收集键六键→四键；`config_snapshot.thresholds` 十一键→九键；同段"十一项阈值""六键齐全即有效裁决"注释一并同步 |
| `src/filter/jev/context.test.ts` | `QUESTION_KEYS` 清单、答案夹具、`projected.answers` deepEqual 六键→四键 |
| `src/tools/llm_context/index.test.ts` | "六道来源级题全 0（保留）"注释同步；HTTP 回放桩夹具枚举六键但断言其他行为，确认后可保留 |
| `src/filter/pipeline.test.ts` 其余 | 多处夹具枚举六键（含两题）但断言的是其他行为——投影自动忽略多余键，**逐个确认后可保留**；若顺手精简夹具，不得改变用例意图 |

### 任务 8：文档

**更新（当前状态类）：**

- `notes/jev-question-writing.md`：题库表格删除两行、移入历史节；`QUESTION_SET_ID` 更新为实施后实际值；"六道"表述；"完整英文题干见 dev/jev_probe.py 顶部"指针补注（该工具是十题历史录制）。
- `filter-notes.md`：源码基线行（filter-rules-11、新题库 ID 实际值）；当前状态加本轮记录（决策依据一句话 + 已知行为回退一条，见决策 8）；并记一句**样本记录面变化归因**：`config_snapshot.thresholds` 与 JSONL 信封的 thresholds 键集由十一项缩为九项（self_deprecated / stale_drop 退役），外部读样本脚本按键名容忍即可。
- `AGENTS.md`：Jev 节"六题全量上下文试运行"更新为四题表述。
- `notes/test-mode-logging.md`：阈值清单十一项→九项。
- `notes/staleness.md`：文首加一行退役注记（2026-10-03 两题退役及指向），正文不改。
- `PLAN.md`：stale / self_deprecated 分题设计段落加退役注记，不改写历史设计。

**不改（历史记录/快照）：** notes/ 各实验轮记录、decisions-log.md、filter-features.md、private-jev-evidence.md、status.md、local-rules-design.md、两份未入库提案、MAINTENANCE_SIMPLIFICATION_PLAN.md、fixtures/ 全部。

## 4. 验证

门禁：`npx tsc --noEmit`、`npm test`、prettier 检查改动文件、`git diff --check`。先查明现存失败，不把历史问题伪装为本轮通过；`npm test` 起始基线约 988 项，数量变化须说明原因（删两用例、迁移/改写若干）。

重点回归：

1. **校验块收缩后防御仍在**：缺 is_listing → keep + validation（sample.test 改写用例）；四键齐全正常裁决。这是本轮最关键的行为验收。
2. 三门槛顺序与含等号语义：边界用例存在且通过。
3. has_original_reasoning 两处保护：现有测试全部原样通过，不改保护相关断言。
4. `QUESTION_SET_ID` 变化：questions.test 配方镜像自动重算通过；样本层写入新值。
5. `pipeline.fixtures.test.ts` 全量跑，确认夹具期望不变（gates 缩短不改变其余门槛的裁决结果）。
6. 投影键自动收缩：context.test 改写用例通过；旧键（v3 十题与本轮两题）按额外字段忽略（legacy-extra-answer 场景）。
7. 旧配置兼容：thresholds 内带 `self_deprecated` / `stale_drop` 的配置文件解析不报错（现有 unknown-key 测试覆盖方向）。
8. dev 基线：不运行 dev 录制断言，不在 smoke 系加四题断言。

## 5. 交付与审查检查表

- 提交可审阅差异 + 实施报告：改动清单对照本方案、测试数量变化说明、实施后实际 `QUESTION_SET_ID` 与 `filter-rules-11`。
- 审查重点：
  1. 裁决校验块确实收缩为四键（不是靠其他改动碰巧通过）；
  2. 门槛顺序、含等号、命中即停取首因语义保持；
  3. 保护逻辑（模板豁免、指纹免删）零改动且测试原样通过；
  4. `SourceDropReason` 两成员与 statusline stale 分支按决策保留并标注；
  5. dev/ 与历史记录零改动；
  6. 文档当前状态类已更新、历史类未改写；
  7. 测试覆盖未净减少（三门槛各自的"恰好等于门槛"边界用例仍在；V3_HISTORICAL_KEYS 历史夹具未动）；
  8. 时间题链条与请求组织零改动。
- 回退：使用本方案实施前的代码版本重新构建；样本、JSONL 与日志保留，不删证据。
