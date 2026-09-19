# Brave MCP × Jev 过滤层

## What This Is

brave/brave-search-mcp-server 的独立"jev 版"分支：在 `brave_llm_context` 工具的返回里嵌入一层**页面粒度**的过滤，去掉重复文章和农场文章，减缓上下文增长，提高送到模型面前的内容质量。使用者是老大本人（Claude Code 会话里的联网搜索），验证后作为独立仓库公开到 GitHub。

## Core Value

`brave_llm_context` 每次返回的来源，都是对 intent 有独立信息价值的页面：一手来源、原创论证、独有事实留下；转述、模板、列表页、旧版页去掉；拿不准时保守，宁可多留。

## Requirements

### Validated

<!-- 上游 2.1.4 已有、本机已验证的能力。 -->

- ✓ 上游八个工具（web / local / video / image / news / summarizer / llm_context / place_search）经 stdio 与 HTTP 两种传输可用 — existing（upstream 2.1.4）
- ✓ Brave LLM Context 请求参数经 zod 校验后透传，响应经 zod 校验后以 JSON 字符串返回 — existing
- ✓ 构建（tsc）、测试（node --test + tsx）、格式检查（prettier）在本机全部通过 — existing，2026-09-19 由代码地图验证
- ✓ 真实 Brave 响应夹具（默认 / strict、Sanity 六组、noise 样本）与 Python 抓样、探测脚本 — existing（阶段零产出）
- ✓ Jev 三条接入路径（直连 / OpenRouter / Vercel 网关）均已探通，直连 key 已到 — existing（阶段零）

### Active

<!-- PLAN.md 第 4 节的阶段一、阶段二。 -->

阶段一（不依赖 Jev 答案）：

- [ ] 过滤层以**纯库**形式嵌入 `execute()`：zod 校验之后、返回之前；输入 Brave 响应 JSON + 请求参数 + intent，输出过滤后 JSON + 一个统计对象；`execute()` 只留几行适配；`off` 模式直通
- [ ] 工具声明改为白名单参数与推荐值，新增必填参数 `intent`（英文一句话，涉及带版本产品时点名当前版本及标志性机制）；不声明 outputSchema、不返回 structuredContent；sources 表精简
- [ ] 本地规则层完整实现：JSON-LD 解析分流、URL 规范化归并、片段预筛、feed 规则与结构性黑名单、空来源 / 一句话来源规则、裁回预算、状态行；每条规则对夹具有手工标注的期望结果
- [ ] Jev 客户端三后端（直连 / OpenRouter / Vercel），请求构造与响应解析为纯函数，Vercel 协议差异在适配层抹平，测试用录好的 `.jev.json` 回放
- [ ] 来源级裁决与片段级裁决按 PLAN 第 3.3 节顺序实现：feed → off_topic → is_listing → self_deprecated → stale → filler（且无原创论证）→ 片段 score → 片段新颖度（指纹播种按 is_primary、论证段保护）→ 空来源规则 → keep
- [ ] 兜底：单来源失败按"留"、连续失败熔断、发送前 32k 估算保护与阶梯降级、进程级并发闸、无候选不调 Jev；三档模式 off / shadow / on 由环境变量切换，所有行为走环境变量
- [ ] 逐请求 JSONL 日志按天滚动；状态行与日志共用同一统计对象；状态行按原因计数，不列被丢来源
- [ ] 命令行对比工具：打印每份夹具过滤前后
- [ ] stdio 冒烟（initialize + tools/call）通过；`~/.claude.json` 切到本目录 `dist/index.js`；补丁脚本退役并保留备份

阶段二：

- [ ] `shadow` 模式跑几天，服务器在真实使用中自动录样本
- [ ] 按 `notes/labeling-rubric.md` 审核影子日志，汇总"本来会被丢掉"清单与可疑误杀给老大，定各阈值与 CJK 门槛，切到 `on`
- [ ] 模型版本变化触发夹具回归，裁决翻转超过小阈值才复核
- [ ] 中文搜索占比不低就优先录中文样本
- [ ] 推 GitHub 前确认公开文件无 Jev 性能数字

### Out of Scope

<!-- PLAN.md 第 2 节否决的路线与第 5 节的否定性结论。 -->

- Claude Code PostToolUse hook 重写结果 — hook 并行、后写覆盖，Python 冷启动，和 MCP 服务器割裂
- 继续给 npx 缓存打补丁 — 只有编译产物，npx 缓存出现第二个实例就失效（已退役）
- 独立中间层 MCP 服务器代理 brave — 多一个进程和一份协议转发代码，收益不比源码嵌入高
- Claude Code 函数钩子插件（`tool.call`） — 需 CC ≥ 2.1.274 早期访问接口，本机跑不了；核心做成纯库后将来二十行适配器即可挂上
- Brave Goggles 域名规则 — 域名粒度本身错误
- 改 ZCode / Claude Code 本身 — 老大否决
- 官方 bx CLI 或 skill 路线 — 绕开 MCP，改变模型使用习惯
- 域名级或"是否官方"判据 — 违反页面粒度原则；黑名单只收结构性农场且手工加入，混合平台永不入列
- Jev 重排结果 — 只做门槛，幸存者保持 Brave 原序
- 过滤后为空时补回被丢来源 — 补回垃圾自相矛盾
- 版本号正则判过时 — Sanity 样本证明旧内容体现在语法时代而非版本号
- 对外提供 Jev 调用 — MCA 2.3(a) 禁止转售

## Context

- 上游：brave/brave-search-mcp-server 2.1.4（MIT），git 远端 `upstream`；我们的改动在分支 `jev`，上游更新用合并。代码地图见 `.planning/codebase/`（STACK / INTEGRATIONS / ARCHITECTURE / STRUCTURE / CONVENTIONS / TESTING / CONCERNS）。
- 设计权威：`PLAN.md`（只描述当前态，结论加路径）；每个主题的"怎么做"住在 `notes/` 的一份主题笔记里（索引 `notes/README.md`）；决策变更记 `notes/decisions-log.md`；过程记录归档 `notes/history/`，只读。
- 阶段零已完成：12 源与 Sanity 六组样本已跑并手工复盘，直连 key 已到，三条接入路径均探通。黄金样本与标注尺子在 `notes/labeling-rubric.md`。
- 老大定下的四条原则：页面粒度（不以域名、不以是否官方为判据）；独立锐评必须保留（有论据的怀疑也算）；延迟不算成本；拿不准时默认保守。
- 待老大定（PLAN 第 6 节）：拿不准时留还是删（现默认保守）；一次搜索多等数秒是否接受；中文搜索占比。待影子期定：各阈值与 CJK 门槛；农场页自我标榜是否抬高论证题；stale 丢弃里官方文档占比（非零即题干或门槛有问题）。
- 已知并接受：每次搜索的关键词和结果正文会发到 TypeSafe 及所选网关，多了一个数据接收方。
- 阶段一实现顺序（PLAN 第 4 节八步）：构建验证 → 三处改动嵌入与纯库骨架 → 本地规则层 → Jev 客户端 → 移植补丁脚本行为 → 对比工具 → stdio 冒烟 → 切换配置。
- 老大不写代码；讨论时讲原理，不给行号。改 `src/` 前需老大明确授权。

## Constraints

- **Legal**: 公开文件（含 `.planning/`、`notes/` 公开笔记、代码注释、提交信息）不得出现任何 Jev 准确率、概率、延迟、成本对比数字 — TypeSafe MCA 2.3(f)；数字只写 `notes/private-*.md`（gitignore）
- **Secrets**: 所有 key 走环境变量或 gitignore 文件，不进仓库；本机 key、代理、配置路径见 `notes/private-local-env.md`；`.jev.json` 探测输出全部 gitignore
- **Tech stack**: 沿用上游 Node ESM + TypeScript 5 + zod 4 + MCP SDK 1.30，`node --test` + tsx 测试，prettier 格式，测试文件与源文件并排；过滤库不含任何 MCP 类型 — 便于将来挂到别的宿主
- **Upstream compatibility**: 对上游只动三处（`execute()` 适配、工具声明、去 outputSchema / structuredContent），其余全部放纯库目录 — 保证 `git merge upstream/main` 可持续；outputSchema 与 structuredContent 必须一起去掉
- **Ordering**: 过滤管道十步顺序固定，任何一步不重排；幸存内容保持 Brave 原序 — 不丢 Brave 的时效和站点权重信号
- **Jev**: 单来源一次请求、并行、进程级并发闸；钉版本 ID；跨来源比较不问 Jev；单请求 state + 全部问题 ≤ 64k token、state + 最长单题 ≤ 32k，超限直接拒绝而非截断
- **Runtime**: Windows 10 + MSYS2 Bash，Node 25；原生 fetch 需 `NODE_USE_ENV_PROXY=1` 才走代理
- **Publishing**: 保留 MIT 与上游署名；个人化中文工具描述放仓库外覆盖文件，仓库里只放通用英文描述
- **Workflow**: 改 `src/` 前需老大明确授权；智能体并发受 API 限额约束 — 执行顺序化，一次只开一个智能体

## Key Decisions

权威在 `PLAN.md` 第 5 节。下表是 2026-09-19 的快照：改决策先改 PLAN 第 5 节对应行并在 `notes/decisions-log.md` 记旧结论，再同步这里。

| Decision | Choice | Rationale | Outcome |
|----------|--------|-----------|---------|
| 挂载点 | A2 源码嵌入；过滤层为纯库，`execute()` 只留适配 | 改动集中在一个文件加一个纯库目录，上游升级用 git 合并 | — Pending |
| 判据 | 页面粒度，不看域名和官方与否 | 老大原则：同一域名既有农场也有专业锐评 | — Pending |
| 排序 | Jev 只做门槛，幸存者保持 Brave 原序 | 不丢 Brave 的时效和站点权重信号；社区实测 Jev 单独重排不赢向量检索 | — Pending |
| 请求模式 | 单来源一次请求，并行，进程级并发闸 | 官方 jaggedness 页：state 无关内容多降准；RAG cookbook 先例 | — Pending |
| 来源级裁决 | Jev 只丢页内可观察性质（无关、列表、自称废弃、旧版、模板）；转述与重复全部交代码 | 12 源样本：Jev 对否定性判断偏温和、正面题分明；"保留题不达标才丢"会误杀只有独有事实的页 | — Pending |
| 改写稿 | 片段级事实指纹增量新颖度；指纹播种按 is_primary 高到低，`off` 模式按 Brave 序；has_original_reasoning 高的来源片段免删 | Brave 排序不保证原文在前；论证段也含专名指纹 | — Pending |
| 空来源 / 一句话来源 | 纯代码 | `notes/non-article-pages.md` | — Pending |
| 非文章页（含付费墙） | URL 规则 + is_listing / paywalled 两题 + 标记截断只做片段级 | FT、WSJ 样本证明付费墙表现为列表页或 feed | — Pending |
| 元数据页 | 走片段级评分 0 档到空来源规则；漏了再加一道 noul；不进黑名单 | 页面粒度原则 | — Pending |
| 版本过时 | 模型在 intent 点名版本；stale 与 self_deprecated 两题分开；版本号正则不做；状态行回显依据版本 | Sanity 六组样本；`notes/staleness.md` | — Pending |
| worth_keeping | 影子期对照，不作主判据 | 题干是反事实问法，整体偏高 | — Pending |
| JSON-LD | 解析分流，不整块删 | FAQ 答案里藏独有事实 | — Pending |
| Brave strict 模式 | 不默认开 | 会砍掉锐评段落 | — Pending |
| 超量抓取 | 默认 1×，倍数留环境变量；>1 时只放大来源数与总 token | 老大倾向不放大 | — Pending |
| 兜底 | 单来源失败按"留"；连续 3 次熔断 60 s；熔断期只跑本地规则并裁回预算；超时初值 15 s | 实测尾延迟远超官方标称，5 s 会频繁掐掉 | — Pending |
| 超限 | 估算公式加 15% 余量；阶梯降级并记级别 | 超限直接 422；`notes/jev-api.md` | — Pending |
| 过滤后为空 | 返回空，不补回 | 老大：补回垃圾自相矛盾 | — Pending |
| 状态行 | 一行按原因计数，不列被丢来源 | 老大：留痕好处不大 | — Pending |
| 黑名单 | 仅结构性农场域名，手工加入；混合平台永不入列 | 页面粒度原则不变 | — Pending |
| intent 参数 | 必填，英文一句话 | Jev 判相关性需要明确依据 | — Pending |
| Jev 版本 | 钉版本 ID；新版本发布后跑样本回归再手动切换 | 官方建议 | — Pending |
| 接入路径 | 直连为主；客户端同时支持 OpenRouter 与 Vercel | 直连 key 已到；`notes/jev-api.md` | — Pending |
| 数据经手方 | 接受 TypeSafe 及所选网关；网关逐请求 ZDR | 老大同意 | — Pending |
| 发布约束 | 公开文件不含 Jev 性能数字 | MCA 2.3(f) | — Pending |
| CJK | 不整体跳过；提高丢弃门槛；中文样本实测 | 官方：可用但准确度低 | — Pending |
| 仓库形态 | 独立"jev 版"，验证后上 GitHub | 老大要求 | — Pending |
| 文档规矩 | 单一归属；决策原地替换并记日志；过程进 history；记忆不做日志 | 老大 2026-09-19 | — Pending |
| GSD 工作流 | 顺序执行、YOLO、跳过项目级调研、粗粒度阶段、智能体继承会话模型 | 老大 2026-09-19：API 撑不起多智能体并发；PLAN v3 已含针对性调查 | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-09-19 after initialization*
