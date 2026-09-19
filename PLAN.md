# Brave MCP × Jev 过滤层：方案（v2，2026-09-19）

> v2 变更：拿到 TypeSafe 直连 key 后用真实样本复核，修订裁决逻辑，新增版本过时 / 付费墙 / 空来源 / 元数据页四类处理，见第 13 节。第 7 节决策表已同步。


## 1. 目标与原则

目标：`brave_llm_context` 的返回里去掉重复文章和农场文章，减缓上下文增长，提高送到模型面前的内容质量。

老大定下的原则：

1. **页面粒度。** 不以域名、不以"是否官方"为判据，只按"这一页有没有原创信息或原创分析"判断。note.com、Medium、Substack 这类平台既有农场也有专业锐评，同一域名不能一刀切。
2. **独立锐评必须保留。** 一篇独立博客对某事的锐评，因为有作者自己的论证，归为高价值来源。
3. **延迟不算成本。** Jev 多花的半秒，远小于模型处理多出来的几千 token 的时间。
4. **拿不准时留还是删：待老大定，默认保守。** 先只删高把握的农场和重复，影子模式数据出来后再逐步收紧。

---

## 2. 已核实的背景事实

### Jev（TypeSafe AI）

- 2026-09-15 早期访问发布，需要 API key（waitlist）。**2026-09-19 已拿到直连 key**（环境变量 `jev_API_KEY`，代码同时接受 `TYPESAFE_API_KEY`）。钉版 ID `jev-1.13.0` 直连可用，`jev-1.13` 直连报 Unknown model（该短 ID 只在 OpenRouter 有效）。
- 不是 LLM，不能生成文本。只返回三种类型化判断加校准概率：`noul`（是/否，给概率）、`choice`（多选一，给概率分布）、`score`（分档打分，给概率和置信度）。
- 接口：`POST https://api.typesafe.ai/v1/systemone`，`Authorization: Bearer $TYPESAFE_API_KEY`，请求体 `{state, model, questions:{key:{type, instructions, criteria}}}`。state 可以是字符串、JSON 对象或文本数组；问题里可以按名字引用 state 的某部分（如 `sources[3].text`）。
- 当前模型 `jev-1.13.0`，别名 `jev-latest`。价格 $0.042/M 输入，输出免费。延迟 70–500ms。限额：单请求 state+全部问题 64k token，state+最长单题 32k token；250k token/s，1200 请求/分钟。
- 官方鼓励一次请求塞很多问题（speculative fan-out），比拆成多次便宜且快。
- 官方文档列出的弱项（docs.typesafe.ai/model-jaggedness/jev-1.13、/concepts/state、/models）：
  - 读题极其字面，判据要写成可观察的具体条件；true 对应 no 的反向题表现更差，一律正向措辞。
  - 避免多层间接和双重否定；问题里按名字指明 state 的哪一部分。
  - 日期只当文本读，不能比先后、算间隔。时效判断必须放代码。
  - 数学和数值弱。
  - state 里无关内容多会降准，先过滤再问。
  - 主要训练语言是英文；"other languages, including CJK scripts, are accepted but currently have lower accuracy"，建议自测并关注 Confidence。

### Brave LLM Context API

- `GET https://api.search.brave.com/res/v1/llm/context`，头 `X-Subscription-Token`。参数：`q`、`count`(≤50)、`maximum_number_of_urls`(≤50)、`maximum_number_of_tokens`(1024–32768)、`maximum_number_of_tokens_per_url`(512–8192)、`freshness`、`goggles`、`country`、`search_lang`。
- 返回 `{grounding:{generic:[{url,title,snippets[]}], map:[], poi?}, sources:{url:{title,hostname,age[]}}}`。snippets 里会混入 schema.org 的 JSON-LD 元数据块。
- **按请求计费**（$5/1k 次），多要结果不加钱，超量抓取再过滤零边际成本。
- 真实样本 `~/.zcode/tmp/260919-053010/fixture_jev_release.json`：5 来源 35 片段约 3.4k token，JSON-LD 块占 26%，无逐字重复，重复是换说法级别。

### 上游服务器

- 仓库 https://github.com/brave/brave-search-mcp-server ，MIT。当前 2.1.4，Node ESM，TypeScript，`tsc` 构建，测试 `node --import tsx --test`，依赖 @modelcontextprotocol/sdk、zod、commander、dotenv、express。
- `src/tools/llm_context/index.ts` 的 `execute()` 很薄：解析参数 → `API.issueRequest('llmContext')` → zod 校验 → 返回 `content` + `structuredContent`。这是过滤层的插入点。
- `src/BraveAPI/index.ts` 用原生 `fetch`。本机 Node 25.5 配合 `NODE_USE_ENV_PROXY=1` 已让 fetch 走代理 127.0.0.1:10808，Jev 调用复用同一机制。

### 本机现状

- `~/.claude.json` 里 brave 服务器走 `cmd /c npx -y @brave/brave-search-mcp-server@2.1.3 --transport stdio --enabled-tools brave_llm_context`，环境变量含 BRAVE_API_KEY、代理三件套、NODE_USE_ENV_PROXY、NO_PROXY。这是配置里唯一一处引用。
- `Desktop/CCplugin/brave_mcp_patch.py`（v4）改 npx 缓存里的 dist：参数白名单、中文工具描述（含"默认英文搜索"等规则）、sources 只留 title/hostname/age、去掉 structuredContent（Claude Code 会把 content 和 structuredContent 渲染两遍）、去掉 outputSchema。npx 缓存另有未固定版本的 2.1.4 实例未打补丁，说明补丁路线脆弱。
- `~/.claude/hooks/pre_brave_llm.py`、`post_brave_llm.py` 只加 additionalContext 提示，按工具名 `mcp__brave__brave_llm_context` 匹配。服务器名 `brave`、工具名 `brave_llm_context` 不变即不受影响。

---

## 3. 路线选择：A2，拉源码嵌入

比较过的路线和结论：

| 路线 | 结论 | 原因 |
|---|---|---|
| 拉上游源码到本地，过滤层嵌进 `execute()`（A2） | **采用** | 源码在手，改动集中在一个文件加一个新目录，上游升级用 git 合并，补丁脚本整个退役 |
| Claude Code PostToolUse hook 用 `updatedToolOutput` 重写结果 | 不采用 | 能做（已从 2.1.258 源码核实），但 hook 并行、后写覆盖，Python 进程冷启动，和 MCP 服务器割裂，两处维护 |
| 继续给 npx 缓存打补丁 | 退役 | 只有编译产物没有源码，npx 缓存出现第二个实例就失效 |
| 独立中间层 MCP 服务器代理 brave | 不采用 | 多一个进程和一份协议转发代码，收益不比 A2 高 |
| Brave Goggles 域名规则 | **撤掉** | 域名粒度本身错误，混合平台无法一刀切，会误伤独立锐评 |
| 改 ZCode / Claude Code 本身 | **撤掉** | 老大明确否决 |
| 走官方 bx CLI 或 skill 路线 | 不采用 | 绕开 MCP，改变模型使用习惯 |

---

## 4. 架构

### 4.1 对上游的三处改动

1. `execute()` 在把 Brave 结果返回给客户端之前，先经过过滤层。
2. 参数声明和工具描述直接在源码里改成现在补丁注入的那套（白名单参数、推荐值），新增 **`intent`（必填）**：模型用一句英文说明想找什么，Jev 据此判相关性。
3. 注册时不声明 outputSchema、不返回 structuredContent，避免客户端渲染两份。

### 4.2 过滤层四个模块（新目录，带各自测试）

**本地规则层**（不需要 key）：

- 删 schema.org JSON-LD 元数据块；删导航、cookie 提示等样板文字。
- URL 规范化合并：http/https、AMP 版、带跟踪参数的变体视为同一来源。
- 5-gram shingle 去逐字重复（通稿转载、页内重复的标题导语）。
- **事实指纹去改写稿**：抽取片段里的数字、日期、引号原文、专有名词组成指纹，指纹高度重合的只留 Brave 顺序里第一条。语言无关、零成本。
- 小型手工黑名单：只收"结构上就是农场"的域名（抓取 GitHub issue / Stack Overflow 做镜像的站、纯 SEO 聚合站），Jev 之前直接剔除。候选由日志提示（某域名反复判为模板填充且从未判为其他），由我列给老大，手工加入。混合平台永不入列。

**Jev 客户端**：

- state 是结构化 JSON：`{query, intent, sources:[{id, url, title, snippets:[...]}]}`，问题按名字引用 `sources[i]` 和 `sources[i].snippets[j]`。
- 题干、判据一律英文。每题正向措辞，只描述一个可观察的文本特征。
- 支持两种模式，用真实样本比较后定：一次请求塞全部来源（便宜）；每个来源单独一次请求并行发（state 更干净，文档说无关内容多会降准，延迟不变，多花的只是重复题干）。
- 不钉版本号，用 `jev-latest`。响应里的实际模型名写进日志。
- 超时、报错、没配 key 一律进入兜底放行。

**裁决层**：

- Jev 只决定丢什么，**幸存内容保持 Brave 原顺序**。Brave 排序里的时效和站点权重不能丢，Jev 的概率适合做门槛不适合细排。
- 按校准概率设阈值，全部可调、全部记日志。
- 过滤后为空就返回空，**不补回**被丢的内容。
- 重组成和现在完全一样的 JSON 形状，末尾附**一行状态说明**（例："丢弃 4 个来源：3 模板填充、1 重复"），让模型知道该不该换词再搜。**不附被丢来源的逐条标题链接。**

**编排层**：

- 超量抓取：模型传的来源数和 token 数视为输出预算，服务器按倍数向 Brave 多要（来源数、总 token、每来源 token 同步放大），过滤后裁回预算。倍数受 Brave 32768 和 Jev 32k 上限约束自动降。模型的习惯和工具描述不用变。
- **兜底放行的定义**：Jev 不可用时只跑本地规则，然后按 Brave 原顺序裁回模型要的预算。结果等价于这层不存在。绝不把超量抓取的几倍内容原样放行。
- 三档模式，环境变量切换：`off`（只跑本地规则）、`shadow`（Jev 照常判断照常记日志，但不真丢）、`on`。
- 逐请求日志：参数、Brave 原文、Jev 请求与答案、每条裁决及触发的判定、耗时、实际模型名。本地文件按天滚动。

### 4.3 Jev 提问设计

来源级，每个来源一组独立 noul（v2 题库；has_original_facts 已按第 9.2 节删除，改由本地增量新颖度顶替）：

| 判定 | 描述的文本特征 | 用途 |
|---|---|---|
| worth_keeping | 这一页对 intent 有独立信息价值 | 直接题，影子期与维度题比较 |
| is_primary | 作者是查询对象的当事方：自己发的公告、文档、仓库、论文、帖子 | 保留加分 |
| has_original_reasoning | 有作者自己的论证或评价：带理由的比较、实测感受、批评 | 保留加分（锐评在此） |
| is_attributed_rewrite | 具体事实前有 according to / as X reported 之类归属语，且无作者独立获得的事实 | 保留题不达标时的丢弃条件 |
| is_template_filler | 只重复主题词、没有具体事实、套话、拼接痕迹 | 高把握则丢 |
| is_off_topic | 与 query/intent 无关 | 高把握则丢 |
| stale | 代码或配置针对的是比 intent 点名版本更旧的做法，且未同时展示现行做法 | 高把握则丢（intent 点名版本时才有意义） |
| self_deprecated | 页面自称已废弃、归档、被别的工具取代、不再维护 | 门槛可低于 stale，因为是页面自己说的 |
| paywalled | 页面声明后续内容需要付费或订阅 | 与代码截断配合 |
| is_listing | 页面是多篇独立文章的列表（标题、日期、链接），不是一篇文章正文 | 高把握则丢；见 notes/non-article-pages.md |

裁决顺序（代码里，阈值见 policy 常量文件）：feed（URL）→ off_topic → filler（且无原创论证）→ self_deprecated → stale → is_listing → 片段级新颖度（重复片段删，全删则来源丢；is_attributed_rewrite 仅作确认）→ keep。幸存者保持 Brave 原序。转述稿规则见 notes/dedup-and-rewrite-policy.md。

片段级，每个片段 1 道 `score`：无关 / 沾边 / 直接回答 intent。低分片段删。

论坛帖（Reddit、HN、V2EX）不按来源整体丢，靠片段级评分留下有内容的评论。

CJK 处理：不整体跳过。来源里 CJK 字符占比高时，丢弃所需的概率门槛比英文高一截；影子模式用中文样本实测后再定。题干、判据、intent 都是英文，不受影响。

### 4.4 可发布结构（老大要求做成独立的"jev 版"）

- 上游仓库作为 git 远端 `upstream`，我们的改动在自己的分支，上游更新用合并。
- 所有行为走环境变量：`TYPESAFE_API_KEY`、模式开关、超量倍数、各阈值、日志目录。key 只走环境变量，不进仓库。
- 带"老大"字样的个人化中文工具描述放仓库外的覆盖文件，仓库里只放通用英文描述。
- 保留 MIT 与上游署名。阶段二验证有效后再推 GitHub。
- 仓库位置：`C:\Users\romantcig\Desktop\brave-search-mcp-server`（沿用上游名，可改名）。

---

## 5. 分阶段计划

### 阶段一（不需要 Jev key）

1. 在本目录拉上游源码（`git init` + 远端 fetch + 检出，本文件不影响），`npm install && npm run build` 验证本机能构建。
2. 三处改动嵌入；本地规则层完整实现；Jev 客户端和裁决层实现但走 `off` 模式。
3. 移植补丁脚本里的参数白名单、描述、sources 精简、structuredContent 去除。
4. 用录好的真实样本写测试；写一个命令行小工具打印每份样本过滤前后对比。
5. 端到端冒烟：脚本起 stdio 服务器发 initialize + tools/call，检查形状。
6. `~/.claude.json` 的 brave 条目切到 `node <本目录>/dist/index.js --transport stdio --enabled-tools brave_llm_context`，环境变量不变。
7. 补丁脚本退役，保留备份。

### 阶段二（拿到 key 后）

1. 接上 Jev，先跑 `shadow` 几天，服务器在真实使用中自动录样本。
2. 审核由我做：读日志，把"本来会被丢掉"的清单和可疑误杀汇总给老大。
3. 定阈值、定批量/单来源模式、定 CJK 门槛，切到 `on`。
4. 建立版本变化触发：日志里模型名一变，自动重跑样本回归比较裁决翻转，翻转超过小阈值才复核。
5. 若中文资料搜索占比不低，优先录中文样本。

### 验收标准

- 每次搜索过滤前后的 token 对比。
- 影子模式清单里的误杀数接近零。
- 老大在真实任务里的主观感受。

---

## 6. 待办与未知

待老大定：

- 拿不准时留还是删（第 1 节第 4 条），当前默认保守。
- 中文资料搜索在日常搜索里的占比，决定阶段二中文样本的优先级。

拿到 key 后已验证（2026-09-19，数字见 notes/private-jev-evidence.md）：

- 单来源一次请求、来源级题加每片段一道 score（最多十几题）直连全部 200；6 并发无限流。
- 超限行为按官方文档与社区核实为 422 拒绝，代码侧发送前保守估算截断。

仍待影子期：中文来源准确度与门槛、各阈值、批量 vs 单来源（已定单来源，不再比较）。

已知并接受的事实：每次搜索的关键词和结果正文会发到 TypeSafe，多了一个数据接收方。

---

## 7. 决策记录

| 决策 | 结论 | 理由 |
|---|---|---|
挂载点 | A2：源码嵌入 | 见第 3 节 |
Goggles 域名规则 | 撤掉 | 域名粒度错误，误伤混合平台上的锐评 |
改 ZCode | 撤掉 | 老大否决 |
判据 | 页面粒度，不看域名和官方与否 | 老大原则 |
延迟 | 不算成本 | 模型处理多余内容更慢 |
兜底放行 | 只跑本地规则并裁回预算 | 否则几倍内容原样放行比不过滤更糟 |
排序 | Jev 只做门槛，幸存者保持 Brave 原序 | 不丢 Brave 的时效和站点权重信号 |
改写稿 | 事实指纹本地去重 | 打分加名额截不掉五篇同稿改写 |
过滤后为空 | 返回空，不补回 | 老大：补回垃圾自相矛盾 |
时效 | 不自动按日期丢；若要做放代码 | Jev 不能比日期；常青内容旧了也有效 |
Jev 版本 | 用 jev-latest，模型名变化触发样本回归 | 老大：无明确 bug 不钉版本；官方示例也用 latest |
被丢来源留痕 | 不留逐条，只留一行计数状态 | 老大：留痕好处不大 |
来源分类 | 6 道独立是非题替代四类 choice | 四类太抽象，Jev 是字面判定器；每题可记日志可追责 |
黑名单 | 允许，仅限结构性农场域名，手工加入 | 混合平台永不入列，页面粒度原则不变 |
intent 参数 | 必填，英文一句话 | Jev 判相关性需要明确依据 |
上线方式 | 阶段二先影子模式，审核由我做 | 阈值有依据，不占老大时间 |
仓库形态 | 可发布的独立"jev 版"，验证后上 GitHub | 老大要求 |
CJK | 不整体跳过，提高门槛，中文样本实测 | 文档说准确度低但可用，建议关注置信度 |
接入路径 | Vercel AI Gateway 免费档优先，客户端同时支持 OpenRouter 与直连 | 老大 2026-09-19 默认同意；key 已配（用户级环境变量 Vercel_API_KEY），账号已绑卡，探测 200 通过
Jev 版本 | 改为钉版本 ID；新版本发布后跑样本回归再手动切换 | 老大 2026-09-19 默认同意；官方建议
数据经手方 | 接受网关作为额外经手方，Vercel 逐请求开 ZDR/no-training | 老大 2026-09-19 默认同意
发布约束 | 公开仓库不含任何 Jev 性能数字；私有笔记走 notes/private-*.md 并 gitignore | 老大 2026-09-19 默认同意；MCA 2.3(f)
超量抓取倍数 | 默认 1×（不放大），倍数作环境变量保留；影子期统计"幸存数不足名额"的频率后再决定 | 老大 2026-09-19 倾向不放大
裁决逻辑 | 改为"保留题不达标才丢"：is_primary、has_original_reasoning 均低于门槛且 is_attributed_rewrite 高于门槛才丢；改写稿主要由本地增量新颖度处理；针对性丢弃题留到影子期见到漏网案例再加 | 老大 2026-09-19 同意；真实 12 源样本显示"丢弃题设高门槛"一个都丢不掉，Jev 对否定性判断的概率天然偏温和，正面题（原创论证、一手来源）反而分明
Brave strict 模式 | 不默认开 | strict 会把锐评段落砍掉，Jev 随后判不出原创论证；见第 13.1 节
版本过时 | 调用模型在 intent 里点名当前版本及标志性机制；Jev 两道 noul：stale（相对 intent 是旧做法且未同时展示现行做法）、self_deprecated（页面自称废弃 / 归档 / 被取代）；版本号正则不做 | 老大 2026-09-19 同意；Sanity 六组样本证明旧内容体现在语法时代而非版本号，纯代码判不了；见第 13.2 节
官方与第三方 | 不按域名给官方加权、不给第三方减分 | 页面粒度原则；官方性已由 is_primary 作为保留加分项
空来源 / 一句话来源 | 纯代码：片段删光的来源删除并同步清理 sources 表；只剩一条短片段且不含 query 实词的删除；含实词的留 | 老大 2026-09-19 同意；不用 Jev
非文章页（含付费墙） | 列表页 / feed / 付费预览 / 元数据页统一处理：URL 规则、is_listing 与 paywalled 两道 noul、标记截断只做片段级 | 老大 2026-09-19 提供 FT、WSJ 样本；详见 notes/non-article-pages.md
元数据页（播客、视频、应用商店页） | 走现有链：片段级评分 0 档 → 片段删光 → 空来源规则删除；用真实样本验证；漏了再加一道 noul"页面只有媒体条目元数据，无正文或听录稿"；不进域名黑名单 | 老大 2026-09-19 提出；页面粒度原则
状态行 | 丢弃按原因分类计数（改写 / 旧版 / 付费墙 / 空 / 模板 / 无关 / 黑名单），让模型据此决定下一步 | 老大 2026-09-19
仓库外资料 | 收进仓库：`fixtures/sanity/`（Sanity 六组样本）、`fixtures/noise/`（付费墙、元数据页样本）、`dev/`（网关探测脚本）、`legacy/`（补丁脚本、hooks 副本）；官方文档与社区文章副本放 `reference/` 并 gitignore，只在 notes 里留 URL；社区仓库副本不进仓库 | 老大 2026-09-19 提出；reference 目录 gitignore 为默认，可改
Jev 性能数字 | 任何 Jev 概率、准确率、延迟数字只写 `notes/private-*.md`；PLAN.md 与公开 notes 只写定性结论 | MCA 2.3(f)；PLAN.md 会随仓库公开

---

## 8. 相关路径

- 配置：`~/.claude.json`（brave 条目）
- 现补丁脚本：`~/Desktop/CCplugin/brave_mcp_patch.py`（退役后保留备份）
- 主题笔记：`notes/`（索引见 notes/README.md；private-* 不入库）
- 开发脚本与夹具：`dev/`（探测脚本、样本抓取脚本）、`fixtures/`（真实 Brave 响应）
- hooks：`~/.claude/hooks/pre_brave_llm.py`、`post_brave_llm.py`
- 真实样本：`~/.zcode/tmp/260919-053010/fixture_jev_release.json`
- Claude Code 源码：`~/.zcode/cc-src/2.1.258`
- Jev 文档：https://docs.typesafe.ai/models 、https://docs.typesafe.ai/concepts/state 、https://docs.typesafe.ai/model-jaggedness/jev-1.13
- 上游：https://github.com/brave/brave-search-mcp-server

---

## 9. 真实样本复盘（2026-09-19，提议，待老大确认后并入第 4/7 节）

样本：query "Jev TypeSafe AI model release"，freshness=pm，count=20，urls=12，总 token 9000，每来源 750。

### 9.1 十二个来源的手工裁决

| # | 来源 | 页面性质 | 手工裁决 | 依据 |
|---|---|---|---|---|
| 1 | theregister.com | 原创报道，带批评（"无幻觉的说法不公平"） | 留 | 原创论证 |
| 2 | winzheng.com | 官方博客的中文改写，JSON-LD 里塞了整篇中文 articleBody | 丢 | 纯转述，无新增 |
| 3 | heise.de | 原创报道，指出"评测来自初创公司自己"、透明度问题 | 留 | 原创论证 |
| 4 | pasqualepillitteri.it | FAQ 套话页，JSON-LD 作者块 11 个社交链接 | 丢 | 模板填充 |
| 5 | aiwiki.ai | 聚合页，但自制了一张"各处宣传数字对照表"标注出处 | 留 | 原创整理 |
| 6 | explainx.ai | FAQ 农场页，唯有 FAQ JSON-LD 里藏了"32K 上下文、无图像输入" | 片段级留 | 独有事实只在一句 |
| 7 | flowtivity.ai | "是否好得不真实"博客，自承没跑过，FAQ JSON-LD | 边缘，默认丢 | 转述加轻微评价 |
| 8 | datacamp.com | 说明文，含端点、jev-latest、SDK 信息 | 留 | 开发者可用的具体事实 |
| 9 | kucoin.com | 转载"ME AI News 快讯" | 丢 | 纯转述 |
| 10 | typesafe.ai/blog | 官方发布文 | 留 | 一手 |
| 11 | mezha.net | 原创报道（API 曾过载、纯合成数据训练、Ronacher 与 Mudholkar 引语），但混入无关导航标题 | 留，删导航片段 | 独有事实 |
| 12 | therundown.ai | 新闻改写，引 Forbes 一句，JSON-LD 引用列表 | 边缘，默认丢 | 转述 |

结果：12 → 6 留（含 1 条片段级保留），约减半。幸存来源内部再去掉 JSON-LD 与导航垃圾，估计再省四分之一。

### 9.2 样本推翻或修正了方案里的哪些点

1. **JSON-LD 不能整块删，要解析后分流。** 6/12 来源带 JSON-LD。其中作者、出版方、日期、sameAs、citation 这类元数据字段确实是纯噪音；但 FAQPage 的 acceptedAnswer.text 和 articleBody 是页面正文本身，explainx 那条独有事实就只在 FAQ 答案里。做法改为：解析 JSON 块，元数据字段删除，正文类字段转成普通文本片段，再和其他片段一起走去重与评分。
2. **重复的主形态是"八成共同事实 + 两成独有内容"，不是整篇同稿。** 十篇都重复 $0.042、70–500ms、9 月 15 日、Almeida 前 OpenAI、RLCD、Kahneman，但 mezha 有独有引语、datacamp 有端点、explainx 有上下文长度。原方案"指纹高度重合只留第一条"按重合比例算会误杀 mezha。改为**增量新颖度**：按 Brave 顺序逐个来源看，抽出数字、专名、引号原文做指纹，和前面已幸存来源的指纹并集比较，新增指纹少于门槛才判为改写稿丢弃。
3. **Jev 只问页内可直接观察的性质，跨来源比较放代码。** 原六题里 has_original_facts（"事实非转引"）要求知道别处有没有说过，这是跨来源推断，Jev 字面判定器不擅长。删掉这一题，由第 2 条的增量新颖度顶替。保留：is_primary、has_original_reasoning、is_attributed_rewrite（"具体事实前有 according to / as X reported 之类归属语"是可观察特征）、is_template_filler、is_off_topic。
4. **超量抓取只放大来源数与总 token，每来源 token 不放大。** 原文写"每来源 token 同步放大"。每来源上限是模型对单个来源体积的预期，放大后裁回要截片段，反而破坏 Brave 的片段排序。总预算放大是为了容纳更多来源，不是让单个来源变胖。
5. **导航垃圾（mezha 的 Moldova、Pentagon 标题）由片段级评分处理，方案已覆盖。** 这类片段没有 query 关键词，也可先用代码做一道廉价预筛：片段里不含 query 任一实词且长度短的直接删，省 Jev 的 state。
6. **FAQ 农场页整体丢与片段级留的边界。** 页面粒度原则下，explainx 有原创事实就该留，但整页留会带进大量套话。默认做法：来源级不丢，片段级只留评分高的那几句，其余片段删除。这样页面进结果但体积很小。

### 9.3 对上游改动位置的确认

上游 `execute()` 是 Brave 响应到 MCP 回复之间唯一的一段函数：解析参数、发请求、zod 校验、返回。过滤层就是在校验之后、返回之前插一个异步管道：本地规则 → Jev 判定 → 裁决重组。Jev 调用复用上游同一套原生 fetch，代理机制不变。改动面仍是"一个文件加一个新目录"，第 3 节结论不变。

---

## 10. 联网调查结论（2026-09-19 第二轮）

来源：docs.typesafe.ai 全站索引与 cookbook、typesafe-ai 官方 GitHub（skills、sdk-js、system-one-adapter-python）、awesome-jev 清单、HN 发布串 493 条评论、四篇独立实测、Brave LLM Context 官方文档页、上游源码。仓库副本在 `~/.zcode/tmp/260919-053010/repos/`，文档副本在 `~/.zcode/tmp/260919-053010/docs/`。

### 10.1 拿 key 的路径：不必等 waitlist

| 路径 | 模型 ID | 端点 | 协议 | 费用 | 备注 |
|---|---|---|---|---|---|
| TypeSafe 直连 | `jev-latest` | `POST api.typesafe.ai/v1/systemone` | 原生 | $0.042/M 输入 | waitlist |
| OpenRouter | `typesafe/jev-1.13`（钉版 `typesafe/jev-1.13-20260917`） | `POST openrouter.ai/api/alpha/decisions` | 与原生完全相同（state/questions/noul） | 同价，预付费 | 已验证端点存在（无 key 返回 401），上下文 32000 |
| Vercel AI Gateway | `typesafe-ai/jev` | `POST ai-gateway.vercel.sh/v4/ai/evaluation-model` | AI SDK v4 评估协议：问题类型 `boolean` 代替 `noul`，请求体 `{state, questions, providerOptions}`，置信度在 `providerMetadata.typesafe.confidence` | 同价；**免费档每月 $5**，首次使用即生效，不买 credits 也能用 | 支持逐请求 ZDR/no-training；有社区项目专门在免费额度内运行 |
| Cloudflare AI Gateway | `typesafe/jev` | Workers `env.AI.run` | 另一套 | 未细查 | 不考虑 |

每月 $5 免费额度按 $0.042/M 折算约 1.19 亿输入 token，远超个人搜索用量。

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

| 来源 | 任务 | 结果 | 对我们的含义 |
|---|---|---|---|
| Near Here（英国活动站） | 50 条活动列表审核，二分类 | Jev 48/50，Mistral Small 42，Gemini Flash-Lite 43；误拒合法 0/13 | 边界清晰的是非题上 Jev 很强 |
| lindfors.no | 24 篇挪威语听证回复，立场/类型/论点 | 与 DeepSeek V4.1 Flash 持平；有序打分 Jev 更好；错的时候自己也报不确定 | 非英语可用，score 类型可靠 |
| mastra-jev-moderation | 俄语客服审核 58 条 | 9/9 敌意拦截、0/49 误伤，中位 0.4s | 兜底设计范本：5s 超时、3 次失败熔断 60s、失败放行 |
| agentjournal.dev | 三个分类任务，"一道直接题" vs "12–14 道维度题 + 本地拟合权重" | 单题弱时拆维度有帮助（日语 NLI 0.837→0.908）；单题已强时拆维度反而**误报多 25 倍**；难任务上 confidence≥0.9 的行准确率只有 72% | 拆题不总是更好；直接题和维度题都问，影子期比较 |
| GoSailGlobal（中英文查询 164 条，9,831 对标注） | Jev 重排 vs bge-m3 向量检索 | 单独重排 NDCG@10 只多 0.012，置信区间过零；很会把最强一条顶到第一，后面重新洗牌；融合才稳赢 | 印证"Jev 只做门槛不做排序" |
| kuhung/understanding-jev（中文） | 汇总社区扰动测试 | 多层转折的钓鱼邮件漏判多；choice 里加无关选项会拉低其他选项的对数几率；选项顺序有偏差 | 题目保持单层可观察；choice 选项集要干净 |
| HN 串 | — | 32k 上下文是最常见抱怨；有人用它做"穷人的排序器"；有人指出校准声明未公开验证 | — |

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

---

## 13. 真实样本复核与新增类别（2026-09-19，拿到 key 后）

### 13.1 Jev 样本复核推翻了 v1 的裁决逻辑

用第 9 节的 12 源夹具跑完整题库（直连，单来源一次请求）。定性结论：

1. **v1 的"丢弃题设高门槛"一个来源都丢不掉。** 手工判丢的 5 个来源，is_template_filler 与 is_attributed_rewrite 都落在门槛之下。Jev 对"这页是垃圾"这类否定性判断给出的概率偏温和，改写稿的归属语概率徘徊在中段。
2. **正面题分明。** 两篇原创报道的 has_original_reasoning 很高，官方博客的 is_primary 接近满值，转载快讯的 is_attributed_rewrite 方向正确。片段级评分同样可靠：无关导航标题被判到 0 档，正文接近 2 档。
3. **worth_keeping 直接题整体偏高**，题干"读者会失去什么"对任何提到主题的页面都近似成立。保留为影子期对照，不作主判据。
4. **strict 模式伤锐评。** 同一查询 strict 版把原创报道的片段砍去一半以上，批评段落被 Brave 自己砍掉，Jev 随后判不出原创论证。strict 不默认开。

据此裁决逻辑改为"保留题不达标才丢"（第 7 节），改写稿主要交给本地增量新颖度。

### 13.2 版本过时：纯代码判不了，靠调用模型点名 + Jev 字面核对

Sanity 六组样本（`fixtures/sanity/`，另一 AI 于 2026-09-19 收集）显示：

- 旧内容体现在**语法时代**（sanity.json 插件数组、`part:@sanity/*` 导入属 v2），不在版本号。类型生成那组 6 个来源没有一处提 v6；自定义列表那组全是 v3 时代代码且无版本标注。版本号正则在这批样本上失效。
- 代码没有产品历史知识，调用模型有。分工：模型在 intent 里点名当前版本及标志性机制（工具描述加一条规则），Jev 对每个来源做字面核对。
- 试跑两种写法：只点名版本（写法 A）与另附过时/现行机制清单（写法 B）。两个 v2 毒源在两种写法下都被高概率判为 stale，官方文档全部低概率；B 分离度更高但要模型多写一段。**先用写法 A**，影子期不够再加 B 的 context 字段。
- "自称废弃"是独立信号：README 写明 superseded 的旧代码生成库，stale 题只给中等概率，self_deprecated 题给出高概率。两题分开问。
- v3 时代但语法仍兼容 v6 的第三方教程，Jev 给中间概率。**不丢**，交给增量新颖度，与官方文档重叠时自然去掉。
- 另一 AI 汇总里"官方来源质量更高"的观察不采用为规则，页面粒度原则不变。

### 13.3 非文章页与转述稿（详见独立笔记）

- 付费墙类别改为**非文章页**（列表页、feed、付费预览、元数据页）：`notes/non-article-pages.md`。FT、WSJ 样本证明付费墙页面通常没有"订阅"标记，而是列表页或 feed。
- 转述稿按**重复内容**裁，不按来源身份裁；片段级、非二极管、Jev 不做跨来源比较：`notes/dedup-and-rewrite-policy.md`。原文抓不到时转述是唯一版本，必须留。

### 13.4 待讨论项状态

1. `src/filter/` 骨架文件已删（2026-09-19）。
2. 工具描述"intent 点名版本"措辞：老大无意见，用第 13.2 节建议句。
3. 付费墙 / 样板标记初始列表：见 notes/non-article-pages.md，老大随时补。
4. `reference/` 目录 gitignore：老大无意见，按默认。

改代码前老大将单独授权；本轮上下文已长，代码工作放到新会话，从 notes/status.md 接续。
