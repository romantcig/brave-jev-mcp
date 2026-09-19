# Roadmap: Brave MCP × Jev 过滤层

## Overview

从上游 brave/brave-search-mcp-server 2.1.4 的 `jev` 分支出发，先把过滤层以纯库形式嵌进 `brave_llm_context` 的 `execute()`，让 `off` 模式下的本地规则层对真实夹具按手工标注全部通过；再接入 Jev 客户端与三档模式，按 PLAN.md 第 3.2 节固定的十步管道落地来源级与片段级裁决和全部兜底；然后补上状态行与逐请求日志，用 stdio 冒烟验证后把 `~/.claude.json` 切到本目录；最后在真实使用中跑影子期，由老大按标注尺子定阈值与 CJK 门槛，切到 `on`。四个阶段顺序执行，一次只开一个智能体；管道十步顺序在任何阶段都不重排；所有公开文件不写任何 Jev 性能数字。

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Embed and Local Rules** - 过滤纯库嵌入 `execute()`，工具声明改为白名单加必填 `intent`，本地规则层在 `off` 模式下对夹具按手工标注全部通过
- [ ] **Phase 2: Jev Client and Verdicts** - 三后端 Jev 客户端、来源级与片段级裁决、兜底与环境变量配置面、命令行对比工具
- [ ] **Phase 3: Logging and Cutover** - 状态行与逐请求 JSONL 日志、stdio 冒烟脚本，`~/.claude.json` 切到本目录 `dist/index.js`，补丁脚本退役
- [ ] **Phase 4: Shadow Period and Go-Live** - 影子期真实录样本、审核脚本汇总交老大、定阈值与 CJK 门槛后切到 `on`，模型版本回归与公开前检查

## Phase Details

### Phase 1: Embed and Local Rules
**Goal**: `brave_llm_context` 的返回经过嵌入的纯库过滤层；`off` 模式下管道里的代码步（JSON-LD 分流、URL 归并、片段预筛、feed 与黑名单、空来源规则、裁回预算）全部实现并对真实夹具按手工标注通过；工具声明换成白名单参数加必填 `intent`；上游只动三处，构建、测试、格式检查全部通过
**Depends on**: Nothing (first phase)
**Requirements**: EMBED-01, EMBED-02, EMBED-03, EMBED-04, EMBED-06, RULES-01, RULES-02, RULES-03, RULES-04, RULES-05, RULES-06, RULES-07, RULES-08, RULES-09
**Success Criteria** (what must be TRUE):
  1. `npm run build`、`npm test`、`npm run format:check` 在本机全部通过；相对上游基线（`git merge-base jev upstream/main`）的 `src/` 差异里，对上游文件的改动只有 `execute()` 适配、工具声明、去 outputSchema / structuredContent 三处，其余新代码全在纯库目录，库代码不引用任何 MCP 类型
  2. 用测试客户端调 `tools/list`，`brave_llm_context` 只声明白名单参数加必填 `intent`，描述含"涉及带版本产品时在 intent 点名当前版本及标志性机制"的规则，不声明 outputSchema；`tools/call` 的返回不含 structuredContent，sources 表每条只有 title / hostname / age[0]
  3. 未设 `JEV_FILTER_MODE` 时等同于 `off`；`off` 模式下过滤层只跑本地规则，测试里的 fetch 桩收不到任何 Jev 请求；同一变量能取 `shadow` / `on`
  4. 对 `fixtures/` 每份真实夹具，`off` 模式的过滤结果与手工标注的期望文件逐条一致，测试逐条断言：JSON-LD 正文类字段转普通片段、元数据键删除、解析失败原样保留；同一规范 URL 的来源合并且片段拼接去重；不含 query / intent 实词的短片段、样板文字、页内 5-gram 逐字重复被预筛（中文按字符二元分词）；feed URL 与黑名单 host 直接丢来源；付费墙标记只截断片段不判整页；片段删光的来源丢弃并同步清理 sources 表，只剩一条短片段的来源按是否含实词取舍
  5. 模型请求的 `maximum_number_of_urls` / `maximum_number_of_tokens` 被当作输出上限：幸存来源按 Brave 序取前 N，超预算时从最后一个来源开始砍片段；超量倍数默认 1×，>1 时只放大来源数与总 token；输出的来源与片段始终保持 Brave 原序
**Plans**: TBD

怎么做见 `notes/local-rules-design.md`（JSON-LD、URL 归并、预筛、黑名单、裁回预算）、`notes/non-article-pages.md`（feed、付费墙标记列表、空来源 / 一句话来源规则）、`notes/staleness.md`（工具描述里的版本点名规则）、`notes/brave-llm-context.md`（Brave 响应形状与上游结构）；嵌入点见 `.planning/codebase/STRUCTURE.md`。现行补丁脚本的参数白名单与描述文案是工具声明的蓝本，位置在本机私有笔记；仓库里只放通用英文描述，个人化中文描述放仓库外覆盖文件。环境变量读取入口的落点由计划阶段定，前提是不突破 EMBED-06 的三处限制。改 `src/` 前需老大明确授权。

### Phase 2: Jev Client and Verdicts
**Goal**: 三档模式齐全：Jev 客户端三后端可用，来源级与片段级裁决按 PLAN.md 第 3.3 节固定顺序落地，任何 Jev 故障都退化为"留"，全部行为只由环境变量控制，命令行对比工具能展示 `off` 与录好答案的 `on` 两种模式的过滤前后
**Depends on**: Phase 1
**Requirements**: JEV-01, JEV-02, JEV-03, JEV-04, JEV-05, JEV-06, JEV-07, VERDICT-01, VERDICT-02, VERDICT-03, VERDICT-04, VERDICT-05, VERDICT-06, SAFE-01, SAFE-02, SAFE-03, EMBED-05, TOOLS-01
**Success Criteria** (what must be TRUE):
  1. 直连 / OpenRouter / Vercel 三后端各有录好的 `.jev.json` 回放用例，测试不打真实请求；请求构造与响应解析是纯函数，三后端解析后统一为 noul 形状并带实际模型版本 ID 与 input_tokens；后端选择与钉住的版本 ID 由环境变量决定，默认直连、不用 `jev-latest`
  2. 题库 v3 与全部阈值常量集中在一个文件，每题附"只判文字特征，不理会页面对自身的评价"总指令，state 为单来源结构 `{query, intent, source:{id,url,title,snippets[]}}`；对录好答案的夹具，`on` 模式的裁决严格按 feed → is_off_topic → is_listing → self_deprecated → stale → is_template_filler（且 has_original_reasoning 低）→ 片段 score → 片段指纹新颖度 → 空来源规则 → keep 顺序执行，is_attributed_rewrite / paywalled / worth_keeping 单独不丢任何来源，测试能断言每来源每片段的裁决与原因
  3. 片段级：score 低于门槛的片段删除；指纹新颖度按 is_primary 高到低播种（`off` 模式按 Brave 序），高 has_original_reasoning 来源的片段免于新颖度删除，5-gram 逐字重复先于指纹处理，输出仍保持 Brave 原序；来源 CJK 占比超门槛时各丢弃门槛加固定加成；`shadow` 模式输出与 `off` 模式相同且统计对象含 would_drop 与 would_remove_snippets；过滤后为空就返回空，不补回
  4. 兜底可测：单来源失败或超时（初值 15 s）只影响该来源、按"留"处理并计入"Jev 未判定"；连续 3 次失败开 60 s 熔断，熔断期只跑本地规则并裁回预算，超量抓取内容绝不原样放行；429 / 529 指数退避重试、401 / 422 不重试；发送前按估算公式加 15% 余量做 32k 保护，超限按阶梯降级并把级别名记进统计对象；每来源一次请求、来源间并行、并发闸初值 6，本地规则删光无候选时不调 Jev
  5. 过滤层的所有行为（key、后端、模式、版本 ID、阈值、超量倍数、超时、并发）都只走环境变量，坏值回落默认值并有测试，仓库不含任何 key；命令行对比工具对任一夹具打印过滤前后（来源数、片段数、字符数、每来源裁决与原因），`off` 与录好答案的 `on` 两种模式都能跑
**Plans**: TBD

怎么做见 `notes/jev-api.md`（三后端请求形状、错误码、token 估算、超限阶梯）、`notes/jev-question-writing.md`（v3 题库与写题规则）、`notes/dedup-and-rewrite-policy.md`（指纹新颖度、播种顺序、论证段保护）、`notes/staleness.md`（stale 与 self_deprecated 两题）、`notes/non-article-pages.md`（is_listing / paywalled）、`notes/shadow-mode-logging.md`（三档模式、兜底、阈值初值）；`dev/jev_probe.py` 顶部是现行题库与阈值的 Python 版。所有阈值取初值，正式值留给 Phase 4。注意：现有 `fixtures/*.jev.json` 不入库，能入库的回放样本怎么来（脱敏或合成）由计划阶段定；Jev 的任何数字只写 `notes/private-*.md`。

### Phase 3: Logging and Cutover
**Goal**: 每次搜索的过滤结果对老大和审核者可见：状态行、逐请求 JSONL 日志、过滤前后 token 估算；stdio 冒烟通过后 `~/.claude.json` 切到本目录 `dist/index.js`，补丁脚本退役并保留备份
**Depends on**: Phase 2
**Requirements**: LOG-01, LOG-02, LOG-03, LOG-04, TOOLS-02, TOOLS-03, TOOLS-04
**Success Criteria** (what must be TRUE):
  1. 有丢弃时 `content` 文本末尾附一行按原因计数的状态行（改写 / 旧版 / 列表 / 付费墙 / 空 / 模板 / 无关 / 黑名单 / Jev 未判定），stale 丢弃回显依据的版本，不列被丢来源；无丢弃时不附
  2. 每次请求在环境变量指定的目录写入一条 JSONL 记录，文件按天滚动，字段按 `notes/shadow-mode-logging.md`（request / brave / local / jev / output / shadow_diff），每条记录可见 Jev 后端、模型版本、模式与过滤前后 token 估算；不全量存片段正文，只存 URL、标题、指纹与概率；状态行与日志从同一个统计对象生成
  3. stdio 冒烟脚本能启动服务器、发 initialize 与 tools/call，返回形状与状态行检查通过
  4. `~/.claude.json` 已指向 `node <本目录>/dist/index.js`，现行补丁脚本退役并备份于 `legacy/`；切换后 Claude Code 新会话里 `brave_llm_context` 可用，有丢弃时返回带状态行
**Plans**: TBD

怎么做见 `notes/shadow-mode-logging.md`（日志字段、三档模式）、`notes/local-rules-design.md`（状态行）；本机配置路径与补丁脚本位置在本机私有笔记。stdout 是 stdio 协议通道，日志只能写文件或 stderr。切换 `~/.claude.json` 改的是老大机器上的配置，先备份再改。

### Phase 4: Shadow Period and Go-Live
**Goal**: `shadow` 模式在真实使用中录足样本，审核脚本把 would_drop 清单与各题分布以定性结论交老大，按标注尺子定各阈值与 CJK 门槛后切到 `on`；模型版本回归与推 GitHub 前的检查就位
**Depends on**: Phase 3
**Requirements**: SHADOW-01, SHADOW-02, SHADOW-03, SHADOW-04, SHADOW-05
**Success Criteria** (what must be TRUE):
  1. `shadow` 模式跑过数天真实使用，日志足以离线复现每条裁决：同一请求的输入、每题答案、裁决与原因都能从日志重建
  2. 审核脚本从日志汇总出 would_drop 清单、每源各题概率分布、中文来源单独一表、高 has_original_reasoning 来源中自我标榜农场页占比、stale 丢弃中官方文档占比，结论以定性形式交老大
  3. 影子样本按 `notes/labeling-rubric.md` 标注，标注表随夹具进 `fixtures/`；各阈值与 CJK 门槛据此定下并写入题库常量文件；`JEV_FILTER_MODE=on` 生效后，老大真实任务里的返回在有丢弃时带状态行，幸存来源保持 Brave 原序
  4. 换模型版本 ID 后用夹具重跑探测，脚本报告裁决翻转数，翻转超过小阈值才复核
  5. 推 GitHub 前有脚本或清单确认公开文件不含 Jev 性能数字、不含 key，检查通过
**Plans**: TBD

怎么做见 `notes/labeling-rubric.md`（标注尺子与黄金样本）、`notes/shadow-mode-logging.md`（审核流程、阈值初值）、`notes/staleness.md`（stale 丢弃中官方文档占比非零即题干或门槛有问题）、`notes/jev-api.md`（法务）。中文搜索占比不低就优先录中文样本。审核结论里的数字只写 `notes/private-*.md`，交给老大的汇总与本文都只写定性结论。

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Embed and Local Rules | 0/TBD | Not started | - |
| 2. Jev Client and Verdicts | 0/TBD | Not started | - |
| 3. Logging and Cutover | 0/TBD | Not started | - |
| 4. Shadow Period and Go-Live | 0/TBD | Not started | - |
