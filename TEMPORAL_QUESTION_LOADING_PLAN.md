# 时间题按需加载实施方案

> **注记（2026-10-03）：片段级时间题机制已整体移除（filter-rules-12），本方案作废，保留为当时基线快照。**

日期：2026-10-02。状态：**冻结规则与离线原型一致，已按审查收敛接入与验证范围；待其他 AI 实施后审查**。本文不是已实施报告。

本轮修订：`intent` 在 MCP 入口为必填非空字符串，缺失或空白会在调用 Brave 前拒绝，不是日常加载策略的一种输入场景。**删除跑分、价格、兼容性、维护状态等主题词的独立启用条件**；删除整个 `mutable_evidence` 组及原 event_or_status 中的状态/维护词，剩余组改名为 event。Redlib 的有效特征是“需求指定 2026 年，材料描述 2024 年”，跑分只是内容形式；应由明确时期条件覆盖，不能作为增加跑分关键词的证据。没有其他独立反例支持被删除的开关。本版 50/117 已重新计算，旧版 45/117 只保留为历史对照。

审查修订：生产路径只在管道中判别一次需求，构题器和 all 规划器只接收启用状态，缺参均保持旧年份策略；验证区分新增覆盖与已有回归；中文调用场景使用明确输入，不为验收例句扩充词表。本次不改冻结规则或历史录制，50/117 的静态统计口径不变。

调查基线：Git `7234b80f0eaec548225c6f821ed7ea4faa5277f7`；源码 `filter-rules-10`、`QUESTION_SET_ID=a83a65132baa`、`jev-context-1`、样本 v4。实施前核对实际基线，保留其他工作，不能把规则版本恢复成旧样本中的 `filter-rules-7`。

探索依据及静态结果见 [filter-notes.md](filter-notes.md#时间题按需加载探索2026-10-02)。目标是减少明显不涉及时间判断的请求中的时间题，保留现有时间过滤的适用场景。

## 1. 本轮决策

采用**本地需求判别 + 现有片段年份条件**，不增加模型调用，不分成两轮 Jev 请求。

需求判别采取保守关闭策略：

- 有 freshness、明确时期、相对时间或事件信号：启用时间题。
- 没有上述信号，且 intent 明确属于已支持的概念解释、机制说明、项目查找：关闭本次搜索的时间题。
- 无法识别需求、无法可靠处理的语言：沿用现有年份策略，继续启用。
- 启用只表示允许给符合旧年份条件的片段提问，不代表已经发送问题，更不代表删除。

候选在固定日常录制的 117 道时间题中跳过 50 道，保留 67 道，减少 **42.74% 的时间题**。不是整次输入 token 减少 42.74%，也不是实际重新调用后的费用结果。原 Gemini 发布样本的 16 道时间题全部保留，原 85 道总题目不会因此减少。

## 2. 实施范围与不变量

本轮只改变 `time_snip{i}` 是否生成，并增加解释本地选择结果的少量日志字段。

以下保持：

1. 六道来源题、全部 `snip{i}` 评分题、三档评分描述、时间题原文、总指令、0.85 时间门槛及其他阈值。
2. 现有年份正则 `\b(?:19|20)\d{2}\b`，以及裁决侧的同一正文年份检查。
3. state 的形状与正文、来源和片段原序、原有十步顺序。
4. 时间判断仍在步 7，先执行评分删除，评分通过后才考虑时间删除；不增加整页时间删除。
5. single、all、all 回退 single 使用同一个需求判别结果。
6. 缺答、非法答案、未实际提问、调用失败的保守行为；缺时间题不影响六题来源裁决有效性。
7. MCP 工具参数、工具描述、Brave 请求字段、外部库依赖和本机配置。

本轮不修“2048 被当年份”或 CVE 编号年份，不增加日期解析器、不用机器当前日期判旧、不根据页面日期删内容、不把 freshness 写进 state。那些问题另有范围；本轮利用 freshness 仅作为“需求涉及时间”的保留信号，不能声称已补齐模型的时间比较基准。

## 3. 需求选择器契约

新增纯模块 `src/filter/jev/temporalDemand.ts`，无 MCP 类型、网络、文件读写和模块级可变状态。

建议接口：

```ts
type TemporalDemandInput = {
  query: string;
  intent: string;
  freshness?: string;
};

type TemporalDemandDecision = {
  policy_id: 'temporal-demand-1';
  enabled: boolean;
  reason:
    | 'freshness'
    | 'explicit_period'
    | 'relative_time'
    | 'event'
    | 'concept'
    | 'mechanism'
    | 'discovery'
    | 'unknown';
};

function decideTemporalDemand(input: TemporalDemandInput): TemporalDemandDecision;
```

### 3.1 顺序及兜底

1. `freshness` 为非空字符串时立即启用；不自行重解析 Brave 的日期范围协议。输入沿用宿主已经解析的参数。
2. query、intent 各自压缩空白并 trim；分别扫描，不能拼接后产生跨字段的匹配。
3. 先扫描 query 的三组正信号，再扫描 intent 的三组正信号；组序固定为 explicit_period → relative_time → event。任何一处命中即启用。该顺序影响记录的 reason，不影响启用结果。
4. 没有正信号时，以已经通过入口校验的 intent 判别关闭条件。仅 query 看起来像概念问题，不足以关闭。`LlmContextInputSchema` 已要求 intent 为 trim 后 1–500 字符，入口测试覆盖缺失和空白拒绝；无需为正常路径再设计“缺少 intent 时如何加载”。纯函数若保留空值防御，只作为异常输入防御，不更改入口契约。
5. 中英文之外、或混有当前识别范围外字符的 intent，退回 `enabled=true / unknown`。首版宁可多问，不凭不认识的文本关闭。
6. 支持的 intent 才依次检查 concept → mechanism → discovery，命中后关闭；无命中则启用并记 unknown。

首版字符支持检查可与仓库外原型一致：ASCII、CJK `U+3400–U+9FFF`、中日韩标点 `U+3000–U+303F`、全角字符 `U+FF00–U+FFEF`、常用标点 `U+2000–U+206F`。这是保守的字符范围筛选，**不是语言识别器**；纯 ASCII 的其他语言仍可能进入规则扫描，因此跨语言泛化不作承诺。不得为增加节省量把 unknown 改成关闭。

不做否定语义解析。例如“不要最新消息，只介绍架构”会因正信号保守启用，这是首版允许的额外开销。多目标需求中只要有一个时间信号，正信号优先。

### 3.2 冻结的首版规则

以下是此次仓库外原型的候选规则。采用普通正则即可，不引入 NLP 库。英文匹配大小写不敏感，保留词边界；中文按短语匹配。正则不要带 `g`，避免复用时 `lastIndex` 影响结果；使用 `u` 保持 Unicode 字符计数一致。

| 组 | 英文规则或短语 | 中文规则或短语 |
|---|---|---|
| explicit_period | 独立 `1xxx` 或 `20xx` 四位数 | 同左；此处只作为需求保留信号，不把数字断言为真实日期 |
| relative_time | latest、recent、recently、current、currently、today、yesterday、tomorrow、now、ongoing、nowadays、up-to-date / up to date；this/last/past/next + week/month/year/quarter/day/数字 days；as of | 最新、近期、最近、目前、当前、现阶段、如今、今天、今日、昨天、明天、今年、去年、截至、截止、近 + 中英文数字 + 天/周/月/年 |
| event | release/releases/released/releasing；launch/launches/launched/launching；announce/announces/announced/announcing/announcement/announcements；rollout、outage(s)、shutdown(s)、lockout(s)、incident(s)、reaction(s)、changelog(s)；breaking changes | 发布、发售、推出、上线、公告、更新日志、停服、宕机、故障、封锁、事件、反应 |
| concept | what + 最多 100 字符 + is/are/refers to；definition、purpose、background、specifications、architecture、architectural、privacy design | 是什么、指什么、含义、定义、原理、架构、用途、背景介绍 |
| mechanism | how to；how + 最多 100 字符 + works/work/was used；workflow、technical details、implementation、code example(s) | 工作流程、技术细节、调用方法、代码示例、实现机制 |
| discovery | find/search/search for/investigate/identify/locate/examine + 最多 180 字符 + project(s)/demo(s)/implementation(s)/alternative(s)/original blog post/original writeup/original source/technical writeup | 查找/寻找/搜索/了解/调查 + 最多 80 字符 + 项目/替代方案/替代品/演示/原文/技术文章 |

`Hacker News`、网址里的 `news`、单独 `discussion` 不自动视为事件信号。查找 HN 上的项目与查找特定事件的反应不同；不能为了简化正则加入一个无条件 `news` 匹配。

不得把 benchmark/performance、price/cost、compatibility、maintenance/maintained、commit activity 等被撤下的主题或状态词换个分组重新加入。也不得因这些词把本已命中非时间条件的请求强行改为 unknown。未知需求兜底仍对所有无法识别的表达统一适用，不是这些主题的特殊保护。若请求同时明确写了 2026、current 等，按其时间特征启用。

完整正则数组保存在仓库外 `temporal-demand-probe.json` 的 `patterns`，本版 `candidate_revision=no-topic-triggers`。实施时可据此移植冻结常量；如果调整词表或控制流，先在同一冻结样本上重新统计，不能继续引用 50/117 作为新规则的结果。

### 3.3 风险界限

概念、机制和项目查找规则是启发式，无法证明需求永远不涉及时间。遗漏同义表达或含蓄时效要求可能使旧内容多留；有正信号时多问则只降低节省量。“信息可能变化”不足以作为独立时间特征，本版已删除这类开关。后续增加条件应给出该条件无法由现有时间/事件信号覆盖的实际反例，不能只按主题的常识推测。

撤下前的额外提问：benchmark 查询三题的概率为 0.18/0.28/0.34，commit activity 查询两题为 0.24/0.26，都没有时间删除；本版全部跳过。这只是撤下后的观测结果，不以低概率证明所有此类查询永远无需时间判断。价格和兼容性独立保护没有实际收益证据。Redlib 以“需求时期与材料时期错位”归类，明确 2026 的条件继续覆盖它。

当前记录中的关闭项最大旧时间概率为 0.39；这有利于选择第一批候选，不能替代新请求验证或泛化验收。

## 4. 接入位置

### 4.1 统一题目构造

扩展 `questions.ts` 的 `buildQuestions`，只接收可选的时间题启用状态，例如 `buildQuestions(input, { temporalEnabled: decision.enabled })`。完整 decision 留在管道中用于记录，构题器不负责需求判别。

- 正文数组形式：只有 `temporalEnabled !== false` 且原 `hasExplicitYear(text)` 为真时追加原时间题。
- 省略选项或 `temporalEnabled`：保持现有正文数组的年份策略，作为旧调用入口的兼容行为，不自动推导需求。
- 数量形式：仍只构造六题 + N 道评分题，没有正文便不构造时间题。它也不能重建历史十题题库。
- 稀疏题键不压缩。原候选片段位置 3 对应 `time_snip3`，不是重新编号为 `time_snip0`。
- 不为了“更方便”把 hasExplicitYear 移入新模块造成循环依赖；新模块不导入 questions.ts。

### 4.2 管道与 all 规划

`pipeline.ts / runJevStage` 是生产路径唯一的需求判别入口：从原始 request 的 query、intent、freshness 计算一次 decision，放在候选派发之前。

- single：将 `decision.enabled` 作为 `temporalEnabled` 显式传给 buildQuestions。
- all：使用 `planAllRequest(candidates, query, intent, { temporalEnabled: decision.enabled })`；规划器逐来源构题时透传该状态，再做命名空间转换和预算检查。
- 规划器省略选项或 `temporalEnabled` 时，与 buildQuestions 一样保持旧年份策略；query/intent 仅用于构造 state，不用于补算需求。构题器与规划器均不调用选择器。
- all 单候选回退、规划超限回退、客户端派发前 too_large 回退，继续传递原 `decision.enabled`；不能回退后重新推导或漏传状态而恢复旧策略。
- 减题发生在预算估算之前。它可能让原本因 64k 超限而回退的请求改为成功采用 all；这是可预期的请求组织变化，需专门测试，不能声称所有请求数恒定不变。

### 4.3 保持裁决与降级共用现有实现

`projectSourceAnswers` 已经要求时间题同时存在于局部构造题集和实际发送题集；维持此防线。模拟服务端返回未提问的 `time_snip` 高概率答案时，仍不得消费。

`applySnippetScores` 没有时间答案便不执行时间删除，因此不需要复制一套“按需模式”的裁决。不要把跳过伪装成概率 0，不要在 verdict 层重新判需求。

客户端现有砍尾连带删除对应时间题、仅来源题降级删除所有时间题的规则继续适用；空时间题集合也是正常输入。

## 5. 可追溯记录与版本

新增可选 `JevStats.temporal_gate`，形状直接使用 TemporalDemandDecision；`SampleJev` 同步增加该可选字段，`buildJevSection` 从管道复制，不能在样本写入阶段重算。

- 字段只存策略 ID、启用状态及 reason，不记录原文匹配串、不放正文，也不进模型 state。
- JSONL 原有 stats 序列化可带出这一无正文字段，检查实际实现并补断言；如果需要显式投影则按现有风格增加。
- 旧样本缺字段表示“没有记录此策略”，不得读作关闭。
- off / no_key 未进入 Jev 阶段时省略；进入阶段但没有候选时可记录已计算 decision，题数和 HTTP 仍为零。
- `enabled=true` 不等于有题。实际发送题目仍以 requests[].questions 和 sent[].temporal_questions_sent 为准；预算降级、无年份、未派发都可能导致零题。
- v4 增加可选字段即可，不改变已有字段含义；不机械升级 format_version。`jev-context-1` 维持，因为模型 state 和来源命名空间布局未改。

新模块导出冻结策略描述（策略 ID、规则组、匹配标志及规范化/兜底版本）。`QUESTION_SET_ID` 的规范化哈希输入必须包含该描述，使题干没变但选择策略变化也能追溯；控制流修改时同步递增策略 ID，不能只对正则做哈希而漏掉兜底变化。

本轮增加本地需求判别并改变请求启用策略，FILTER_RULES_VERSION 采用实施时的下一版本。若基线仍是 10，则改为 11；若其他工作已推进，按新基线顺延，不覆盖他人改动。无需改包版本或模型版本。

## 6. 文件责任清单

下表列出实现与验证责任，不要求每个列出的文件都产生修改。已有测试直接复用；仅为新增行为或确认的覆盖缺口补充用例，新增与复用范围见 §7。

| 文件 | 实现或验证责任 |
|---|---|
| `src/filter/jev/temporalDemand.ts`（新增） | 纯选择器、冻结规则描述、策略版本 |
| `src/filter/jev/temporalDemand.test.ts`（新增） | 启用/关闭/unknown、多语言、优先级与状态无关性 |
| `src/filter/jev/questions.ts`、`.test.ts` | 可选启用状态、哈希描述与旧调用兼容；复用稀疏题键回归 |
| `src/filter/jev/context.ts`、`.test.ts` | all 透传启用状态、缺参保持旧策略、预算在减题后计算；复用命名空间与身份映射回归 |
| `src/filter/pipeline.ts`、`.test.ts` | 搜索级计算一次、single/all/回退传递启用状态、记录完整 decision |
| `src/filter/types.ts` | 纯数据契约与可选统计字段；避免运行时循环依赖 |
| `src/filter/sample.ts`、`.test.ts` | 可选字段复制、QUESTION_SET_ID 配方断言；复用实发映射回归 |
| `src/filter/temporal.test.ts` | 补充按需关闭的集成用例，复用原时间删除链条回归 |
| `src/filter/jev/client.test.ts` | 复用砍尾、仅来源题降级回归；空/稀疏时间题集合仅补现有未覆盖的组合，客户端正文逻辑原则上不用改 |
| `src/filter/logging.test.ts` | 无正文策略字段及旧形状兼容；logging.ts 按实际序列化是否需要调整 |
| `src/filter/version.ts` | 规则版本顺延及中文说明 |
| `notes/jev-question-writing.md`、`filter-notes.md` | 更新当前生成条件、记录已实施/验证/未验证状态 |

检索 `buildQuestions(` 和 `planAllRequest(` 的所有调用。生产构题只有 pipeline 与 context 两处；dev 中许多历史实验仍依赖无新增参数的旧行为，不能批量改写历史脚本来冒充原始录制。新验证入口应显式选择旧策略或新策略：验证新策略时，根据完整 query/intent/freshness 计算 decision，再向构题器或规划器传入启用状态，并校验完整请求指纹。

`dev/full-context-smoke.mjs` 当前直接调用 planAllRequest，只传 query/intent。缺参时保持其旧策略行为；若复用它验证新策略，应在验证入口显式计算并传入启用状态，使规划与实际管道使用同一策略，包含 freshness-only 场景。

现有 `dev/smoke_stdio.ts`、`dev/smoke-rollout.ts` 仍有旧十题录制断言。若运行时遇到既有不一致，记录并区分基线失败与本次回归，不得改真实旧夹具或把伪造时间零值标成 Jev 实测。单测、类型检查不能代替这项状态说明。

## 7. 必须覆盖的验证

### 7.1 选择器边界

测试应写出具体 query、intent、freshness，不把场景概述当作对任意同义表达的支持承诺。下表未注明 freshness 时均省略该参数。

| 情况 | 预期 |
|---|---|
| “Jev 是什么/架构原理”，正文含发布年份 | 关闭时间题，常规题保持 |
| query=`Brave API`、intent=`Brave API 调用方法`，正文只有 2048 和发布日期 | 关闭，reason=mechanism；不宣称修好了年份识别 |
| query=`Brave API`、intent=`怎么调用 Brave API`，正文相同 | 启用，reason=unknown；冻结词表未覆盖“怎么调用”，不为此例扩词表 |
| 查找 Jev 去广告项目 / HN 上的项目讨论，无时效信号 | 关闭 |
| 同一意图加非空 freshness | 启用，reason=freshness |
| query 含 2026，intent 只说项目介绍 | 启用，不能忽略 query |
| 当前可用性 / 最新版本，含 current/latest 等时间信号 | 启用，依据时间词 |
| 已识别为概念/机制/项目查找，仅多出跑分/价格/兼容/维护主题词 | 仍关闭，不得被主题词翻转为启用或 unknown |
| 上一行相同需求再加明确 2026 或 current | 启用，依据时期或相对时间 |
| Cloudflare public CA reactions，无明确年份 | 启用，保护唯一日常命中的选择路径 |
| Gemini release/launch 查询 | 启用，16 道原时间题保留 |
| 需求指定 2026，材料写 2024；内容形式可以是测量或其他内容 | 启用；选题依据请求时期，年份与时期是否错位仍交 Jev 判断 |
| 需求指定 2024 的历史查询，材料也属于 2024 | 启用，由 Jev 判断匹配并保留；不把历史查询一律视为不需时间 |
| “工作原理＋最新发布”混合目标 | 启用，正信号优先 |
| intent 缺失或全空白 | MCP 入口拒绝，不进入加载策略；沿用已有入口测试 |
| 合法 intent 的需求或语言不认识 | 沿用旧策略 |
| query=last、intent=year architecture | 不因跨字段拼接形成 last year；按 intent 概念规则关闭 |
| 重复调用同一个选择器输入 | 返回完全相同，不受前一请求影响 |

仓库外修订原型已运行 38 项边界检查，包含主题词不触发、加入明确年份后才触发的成对检查；原空值检查仅属纯函数异常输入防御。这不是生产 TypeScript 测试已通过。本次审查明确的两条中文调用输入应补入实施测试，不更改历史 38 项检查记录。

### 7.2 集成与工程

本轮新增或扩展的覆盖：

1. single/all 同一请求使用相同启用状态并产生相同局部题键；关闭时六道来源题及所有评分题逐字保持，state 深比较相同，未提问的额外高概率时间答案被忽略。
2. all 回退 single 的三种原因均保持原启用状态；覆盖关闭需求及 freshness-only 启用需求，避免漏传后恢复旧策略或丢失 freshness 信号。
3. 减题发生在预算检查之前；覆盖原本超过 64k、关闭时间题后可采用 all 的输入。
4. buildQuestions 与 planAllRequest 缺参时均保持旧年份策略，包括 query/intent 原本可命中关闭规则的情况；显式传入启用状态时再应用新策略。
5. 新日志字段从执行事实复制，旧记录缺字段不被读作关闭；验证 §5 的 off/no_key/零候选记录约定，结合已有实发记录区分选择关闭、无年份、预算删题和未派发；更新题库哈希与规则版本的相关断言。

以下复用现有回归；核对覆盖后，只补实际缺口：

1. 位置 0/3 含年份时只生成 time_snip0/time_snip3；预筛、URL 合并、JSON-LD 拆分后的身份与原系统一致。
2. 对启用场景，原 0.85 边界、坏值/缺答、评分先删、来源先删、失败保留继续成立。
3. 32k 砍尾和 64k 仅来源题降级后，sent 标记与真实载荷一致；确认空/稀疏时间题集合的覆盖。
4. test/on 结果和裁决一致；off 零调用；no_key、零候选、失败、熔断不虚增题数或 HTTP。

执行项目必要门禁：`npm test`、`npm run format:check`、`npm run build`、`git diff --check`。先查明现存失败，不把历史问题伪装为本轮通过。已有覆盖可直接作为验收依据，无需在多个测试文件重复同一套场景。

### 7.3 日常样本和历史回归

冻结的日常样本范围：77 份完整样本，最新时间为 2026-10-02 05:40:35 +08:00；另三条早期 JSONL 只用于范围对账。样本清单及逐题数据见仓库外审计产物。新样本另组统计，不能把旧比例套到变化后的分母。

离线验收：

- 对已录制的 query/intent/freshness 和实发候选运行选择器，得到关闭 15 次搜索、跳过 50 道题、保留 67 道题；唯一日常命中的问题仍被选择。
- 这仅是“固定输入下的选题统计”。不能把旧答案裁成子集后写成新策略的真实回答；也不能把规则 4/7 的旧 state 与当前规则 10 清洗后的 state 当作同一输入。
- 回看第十四轮 56 份分类录制，四份存在高概率时间答案的请求均不得被选择器关闭。四份中有些先被来源/评分规则删除，**不能称为四次时间删除**。
- Redlib 需求明确 2026 而材料描述 2024 的历史用例仍由 explicit_period 启用；不得记录成“跑分触发”。2024 历史查询保留时间题并允许低概率保留正文；实例列表、重定向说明不因同页年份而扩大提问。
- Cloudflare 2014 背景＋当前 CA 意义、Marmont 1969 资料来源、TypeScript 历史迁移说明作为混合时间材料保留在审阅清单。保留问题不等于保证原删除正确。

完成工程检查后，真实请求验收使用少量有区分力的冻结输入：概念查找、Brave 调用、项目发现、freshness-only 机制需求、Cloudflare 事件、Redlib 当前/历史对照。先输出请求清单、完整 state/questions 指纹及含重试的估算预算，再通过有总量限制的入口执行；不默认重发全部历史主题。原题和新题需在相同 state、模型版本和后处理规则下比较。未变化的请求可按完整请求指纹复用录制；有变化的题集必须重新取答才能报告真实结果。

验收看实际用量和对 intent 有用的独有信息保留。旧问题未触发、原始答案相同、最终段数相同都不能代替正文审阅。若未执行真实验收，实施报告明确写“工程完成，真实行为及实际节省未验证”，不能填写零误删或总体误删低于 4%。

## 8. 交付与审查检查表

- 提交可审阅代码差异及实施报告，说明规则命中、样本范围、实际/估算用量、正文变化、未解决问题。
- 不顺带精简其他题、调整门槛、改变 GitHub 清洗或更新模型。
- 不修改私有配置或切换正在运行的 MCP 进程来替代验收；是否部署按实施任务当时的授权执行。
- 回退使用本次实现之前的代码版本并重新构建；保留日志与样本，不删除证据。
- 回交审查重点：未知需求是否误关闭、freshness 是否贯穿回退、题目是否在预算前裁减、未提问答案是否被消费、日志是否重建伪造、历史实验是否被计入日常分母、实际节省是否被静态估算冒充。

## 9. 本地证据入口

目录：`C:/Users/romantcig/.scratch/261002/brave-search-mcp-server-608b1e9a/`。

- `audit_temporal_questions.py`、`temporal-question-audit.json`：日常全量去重统计及逐题身份。
- `probe_temporal_demand.py`、`temporal-demand-probe.json`：冻结候选规则及每次搜索的选择结果。
- `check_temporal_demand_probe.py`、`temporal-demand-probe-checks.json`：38 项修订原型边界检查。
- `temporal-sample-manifest.json`：77 份样本和相关原型文件的 SHA-256 清单。
- `topic-guards-before-removal/`：旧版主题保护原型及 45/117 结果的冻结副本，仅作历史对照，实施不要读取此目录的旧规则。

历史录制目录：`C:/Users/romantcig/.scratch/261001/brave-search-mcp-server-92eafe7c/round14-rollout/`；其中 56 份 `*.record.json` 与 `results.json` 分别记录实际问答和端到端结果。参见 [第十三轮](notes/filter-experiments/round-13-temporal-relevance.md)、[第十四轮](notes/filter-experiments/round-14-temporal-rollout.md)。

本次探索零新增 HTTP，未修改生产 TypeScript、配置、dist 或历史录制。原始正文与探测输出继续留仓库外。
