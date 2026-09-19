# Requirements: Brave MCP × Jev 过滤层

**Defined:** 2026-09-19
**Core Value:** `brave_llm_context` 每次返回的来源，都是对 intent 有独立信息价值的页面：一手来源、原创论证、独有事实留下；转述、模板、列表页、旧版页去掉；拿不准时保守，宁可多留。

来源：`PLAN.md` v3（第 3、4、5 节）与 `notes/` 主题笔记。每条需求在 PLAN 或笔记里都有对应的"怎么做"，本文只列"做到什么算完"。所有验收都只写定性结论，不写 Jev 数字（MCA 2.3(f)）。

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### 嵌入与工具声明（EMBED）

- [ ] **EMBED-01**: 过滤层是不含任何 MCP 类型的纯库：输入 Brave 响应 JSON、请求参数、intent，输出过滤后 JSON 加一个统计对象；`execute()` 在 zod 校验之后、返回之前调用它，自身只留几行适配
- [ ] **EMBED-02**: `JEV_FILTER_MODE=off` 时过滤层只跑本地规则、不调 Jev；模式缺省即 off；`shadow` 与 `on` 两档由同一环境变量切换
- [ ] **EMBED-03**: `brave_llm_context` 的工具声明改为白名单参数与推荐值（沿用现行补丁脚本那套），新增必填参数 `intent`：英文一句话说明想找什么；工具描述含"涉及带版本产品时在 intent 点名当前版本及标志性机制"的规则
- [ ] **EMBED-04**: 工具不声明 outputSchema、不返回 structuredContent；返回的 sources 表只留 title / hostname / age[0]；stdio 下 initialize + tools/call 的返回形状被 Claude Code 内嵌的 MCP SDK 接受
- [ ] **EMBED-05**: 过滤层的所有行为（key、后端选择、模式、阈值、日志目录、超量倍数、超时、并发）都走环境变量；仓库不含任何 key；坏值（非数字、负数）回落默认值而不是让整层静默失效
- [ ] **EMBED-06**: 对上游只动三处（`execute()` 适配、工具声明、去 outputSchema / structuredContent），其余全部在纯库目录；`git merge upstream/main` 后构建与测试仍通过

### 本地规则层（RULES）

- [ ] **RULES-01**: JSON-LD 片段解析分流：元数据键删除，`articleBody` / 长 `description` / `headline` / FAQPage 问答对 / HowTo 步骤转为普通片段；解析失败或无 schema.org 键的 JSON 原样保留
- [ ] **RULES-02**: URL 规范化归并：小写 host、去 `www.`、去 AMP 标记、去跟踪参数、去尾斜杠与 fragment、http→https；同一规范 URL 的多条来源合并、片段拼接去重
- [ ] **RULES-03**: 片段预筛：不含 query / intent 实词的短片段、样板文字（列表可增补）、页内 5-gram 逐字重复只留第一条；中文按字符二元分词
- [ ] **RULES-04**: feed URL 规则（`rss` / `feed` / `.xml` / `feeds.` 前缀）直接丢来源；手工黑名单文件只收结构性农场域名，一行一个规范 host
- [ ] **RULES-05**: 片段删光的来源丢弃并同步清理 sources 表；只剩一条短片段的来源，不含 query 实词删、含实词留
- [ ] **RULES-06**: 裁回预算：模型请求的 `maximum_number_of_urls` 与 `maximum_number_of_tokens` 视为输出上限，幸存来源按 Brave 序取前 N，超预算时从最后一个来源开始砍片段；超量倍数默认 1×，>1 时只放大来源数与总 token
- [ ] **RULES-07**: 付费墙标记列表（中英文）只做片段级截断，不据此判整页
- [ ] **RULES-08**: 幸存来源与片段保持 Brave 原序，管道任何一步不重排
- [ ] **RULES-09**: 每条本地规则对 `fixtures/` 真实夹具有手工标注的期望结果文件，测试逐条断言；`off` 模式下对两份 Jev 发布夹具的过滤结果与标注一致

### Jev 客户端（JEV）

- [ ] **JEV-01**: 客户端支持三后端：TypeSafe 直连、OpenRouter、Vercel AI Gateway，由环境变量选择；直连为默认
- [ ] **JEV-02**: 请求构造与响应解析是纯函数；内部统一用 noul 形状，Vercel 的 boolean / `probability` / providerMetadata confidence 在适配层抹平；答案里带实际模型版本 ID 与 input_tokens
- [ ] **JEV-03**: 题库 v3（来源级十道 noul 加每片段一道三档 score）与全部阈值常量集中在一个文件；每题附"只判文字特征，不理会页面对自身的评价"总指令；state 为单来源结构 `{query, intent, source:{id,url,title,snippets[]}}`
- [ ] **JEV-04**: 每个来源一次请求，来源之间并行；进程级并发闸（初值 6，环境变量可调）；本地规则删光无候选时不调 Jev
- [ ] **JEV-05**: 发送前用无分词器估算公式加 15% 余量做 32k 保护；超限按阶梯降级（元数据与导航片段已删 → 按 Brave 序砍尾部片段 → 只留来源级题 → 该来源不问 Jev），每级记级别名进统计对象
- [ ] **JEV-06**: 钉版本 ID，不用 `jev-latest`；版本 ID 由环境变量覆盖
- [ ] **JEV-07**: 客户端测试用录好的 `.jev.json` 回放，不打真实请求；三后端的请求形状与响应解析各有回放用例

### 裁决（VERDICT）

- [ ] **VERDICT-01**: 来源级裁决按固定顺序：feed（URL）→ is_off_topic → is_listing → self_deprecated → stale → is_template_filler（且 has_original_reasoning 低）→ 片段级 → 空来源规则 → keep；is_attributed_rewrite 与 paywalled 单独不丢任何来源；worth_keeping 只记日志
- [ ] **VERDICT-02**: 片段级 score 低于门槛的片段删除
- [ ] **VERDICT-03**: 片段级事实指纹增量新颖度：指纹元素为数字、日期、专名、长引号原文、代码标识符；播种顺序按 is_primary 高到低（`off` 模式按 Brave 序），输出保持 Brave 序；has_original_reasoning 高于门槛的来源片段免于新颖度删除；5-gram shingle 逐字重复在指纹之前先做
- [ ] **VERDICT-04**: 来源 CJK 占比超过门槛时，各丢弃门槛加固定加成
- [ ] **VERDICT-05**: `shadow` 模式下 Jev 照常判断、照常记日志，输出仍是本地规则层结果，日志记 would_drop 与 would_remove_snippets
- [ ] **VERDICT-06**: 过滤后为空就返回空，不补回被丢来源

### 兜底（SAFE）

- [ ] **SAFE-01**: 单来源请求失败或超时（初值 15 s）只影响该来源，该来源按"留"处理，其余照常；统计对象计入"Jev 未判定"
- [ ] **SAFE-02**: 失败计数跨请求累计，连续 3 次开 60 s 熔断，熔断期只跑本地规则并裁回预算；绝不把超量抓取的内容原样放行
- [ ] **SAFE-03**: 429 / 529 指数退避重试，重试耗尽按失败处理；401 / 422 不重试

### 状态行与日志（LOG）

- [ ] **LOG-01**: 状态行追加到 `content` 文本末尾，一行按原因计数（改写 / 旧版 / 列表 / 付费墙 / 空 / 模板 / 无关 / 黑名单 / Jev 未判定），不列被丢来源；stale 丢弃回显依据的版本；无丢弃时不附
- [ ] **LOG-02**: 逐请求 JSONL 日志按天滚动，目录由环境变量指定，字段按 `notes/shadow-mode-logging.md`（request / brave / local / jev / output / shadow_diff）
- [ ] **LOG-03**: 状态行与日志从同一个统计对象生成；日志不全量存片段正文，只存 URL、标题、指纹与概率
- [ ] **LOG-04**: Jev 后端、模型版本、模式在日志每条记录里可见

### 工具与切换（TOOLS）

- [ ] **TOOLS-01**: 命令行对比工具对任一夹具打印过滤前后（来源数、片段数、字符数、每来源裁决与原因），`off` 与录好答案的 `on` 两种模式都能跑
- [ ] **TOOLS-02**: stdio 冒烟脚本：启动服务器，发 initialize 与 tools/call，检查返回形状与状态行
- [ ] **TOOLS-03**: `~/.claude.json` 切到 `node <本目录>/dist/index.js`；现行补丁脚本退役并保留备份于 `legacy/`；切换后 Claude Code 里 `brave_llm_context` 可用
- [ ] **TOOLS-04**: 每次搜索的过滤前后 token 估算写入日志，供验收对比

### 影子期与上线（SHADOW）

- [ ] **SHADOW-01**: `shadow` 模式在真实使用中自动录样本，日志足以离线复现每条裁决
- [ ] **SHADOW-02**: 审核脚本从日志汇总 would_drop 清单与每源各题概率分布、中文来源单独一表、高 has_original_reasoning 来源中自我标榜农场页占比、stale 丢弃中官方文档占比；结论交老大
- [ ] **SHADOW-03**: 按 `notes/labeling-rubric.md` 标注影子样本，定各阈值与 CJK 门槛，切到 `on`；标注表随夹具进 `fixtures/`
- [ ] **SHADOW-04**: 模型版本变化时用夹具重跑探测并比较裁决翻转数，翻转超过小阈值才复核
- [ ] **SHADOW-05**: 推 GitHub 前有一道检查（脚本或清单）确认公开文件不含 Jev 性能数字、不含 key

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### 扩展

- **EXT-01**: Claude Code 函数钩子插件（`tool.call`）适配器，把纯库挂到 CC ≥ 2.1.274 的早期访问接口
- **EXT-02**: 写法 B：intent 之外另附 `context.obsolete` / `context.current` 机制清单，影子期写法 A 不够时启用
- **EXT-03**: 黑名单候选提示脚本：从日志里找出多次被判 filler 且从未被判 reasoning / primary 的 host，列给人工
- **EXT-04**: 元数据页专用 noul，仅当片段级评分链漏判时加

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Claude Code PostToolUse hook 重写结果 | hook 并行、后写覆盖，Python 冷启动，和 MCP 服务器割裂 |
| 继续给 npx 缓存打补丁 | 只有编译产物，npx 缓存出现第二个实例就失效 |
| 独立中间层 MCP 服务器代理 brave | 多一个进程和一份协议转发代码，收益不比源码嵌入高 |
| Brave Goggles 域名规则 | 域名粒度本身错误 |
| 改 ZCode / Claude Code 本身 | 老大否决 |
| 官方 bx CLI 或 skill 路线 | 绕开 MCP，改变模型使用习惯 |
| 域名级或"是否官方"判据；混合平台入黑名单 | 违反页面粒度原则 |
| Jev 重排结果 | 只做门槛；丢 Brave 时效与站点权重信号 |
| 过滤后为空时补回被丢来源 | 补回垃圾自相矛盾 |
| 版本号正则判过时 | Sanity 样本证明旧内容体现在语法时代而非版本号 |
| 让 Jev 做跨来源比较、比大小、算日期 | 官方规则：Jev 不擅长；放代码 |
| Brave strict 模式默认开 | 会砍掉锐评段落 |
| 对外提供 Jev 调用 | MCA 2.3(a) 禁止转售 |
| 公开任何 Jev 性能数字 | MCA 2.3(f) |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| EMBED-01 | Phase 1 | Pending |
| EMBED-02 | Phase 1 | Pending |
| EMBED-03 | Phase 1 | Pending |
| EMBED-04 | Phase 1 | Pending |
| EMBED-05 | Phase 2 | Pending |
| EMBED-06 | Phase 1 | Pending |
| RULES-01 | Phase 1 | Pending |
| RULES-02 | Phase 1 | Pending |
| RULES-03 | Phase 1 | Pending |
| RULES-04 | Phase 1 | Pending |
| RULES-05 | Phase 1 | Pending |
| RULES-06 | Phase 1 | Pending |
| RULES-07 | Phase 1 | Pending |
| RULES-08 | Phase 1 | Pending |
| RULES-09 | Phase 1 | Pending |
| JEV-01 | Phase 2 | Pending |
| JEV-02 | Phase 2 | Pending |
| JEV-03 | Phase 2 | Pending |
| JEV-04 | Phase 2 | Pending |
| JEV-05 | Phase 2 | Pending |
| JEV-06 | Phase 2 | Pending |
| JEV-07 | Phase 2 | Pending |
| VERDICT-01 | Phase 2 | Pending |
| VERDICT-02 | Phase 2 | Pending |
| VERDICT-03 | Phase 2 | Pending |
| VERDICT-04 | Phase 2 | Pending |
| VERDICT-05 | Phase 2 | Pending |
| VERDICT-06 | Phase 2 | Pending |
| SAFE-01 | Phase 2 | Pending |
| SAFE-02 | Phase 2 | Pending |
| SAFE-03 | Phase 2 | Pending |
| LOG-01 | Phase 3 | Pending |
| LOG-02 | Phase 3 | Pending |
| LOG-03 | Phase 3 | Pending |
| LOG-04 | Phase 3 | Pending |
| TOOLS-01 | Phase 2 | Pending |
| TOOLS-02 | Phase 3 | Pending |
| TOOLS-03 | Phase 3 | Pending |
| TOOLS-04 | Phase 3 | Pending |
| SHADOW-01 | Phase 4 | Pending |
| SHADOW-02 | Phase 4 | Pending |
| SHADOW-03 | Phase 4 | Pending |
| SHADOW-04 | Phase 4 | Pending |
| SHADOW-05 | Phase 4 | Pending |

**Coverage:**
- v1 requirements: 44 total
- Mapped to phases: 44
- Unmapped: 0 ✓

---
*Requirements defined: 2026-09-19*
*Last updated: 2026-09-20 after roadmap creation*
