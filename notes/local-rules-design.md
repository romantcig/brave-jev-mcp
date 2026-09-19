# 本地规则层设计（不依赖 Jev，阶段一实现）

依据：2026-09-19 两份真实夹具（fixtures/jev_release_default.json、_strict.json）的观察。所有规则语言无关、零成本、可单测。

## 管道顺序

Brave 响应 → 1 JSON-LD 分流 → 2 URL 归并 → 3 片段预筛 → 4 事实指纹增量新颖度 → 5 黑名单 → （Jev 层，off 模式跳过）→ 6 裁回预算 → 7 附状态行 → 输出。

幸存来源与片段**保持 Brave 原序**。任何一步都不重排。

## 1. JSON-LD 分流

- 判定：片段去空白后以 `{` 或 `[` 开头且能被 JSON.parse。解析失败的当普通文本。
- 删除的键（纯元数据）：author、publisher、editor、sameAs、citation、keywords、articleSection、inLanguage、isAccessibleForFree、datePublished、dateModified、wordCount、timeRequired、interactionStatistic、image、url、@context、@type、name（顶层）、item、mainEntityOfPage、breadcrumb、itemListElement。
- 转正文的键：`articleBody`、`description`（仅当长度 > 200）、`headline`（并入标题去重）、FAQPage 的 `mainEntity[].name` + `acceptedAnswer.text`（每个问答对拼成一段"Q: … A: …"），HowTo 的 step text。
- 转换后的文本按普通片段参与后续步骤；其中 articleBody 往往与正文片段重复，交给第 4 步处理。
- 表格/代码块类 JSON（无 schema.org 键）原样保留。

## 2. URL 归并

规范化：小写 host；去 `www.`；去 AMP 标记（`/amp/`、`amp.` 前缀、`?amp=1`、`.amp`）；去跟踪参数（utm_*、fbclid、gclid、ref、source 等白名单外的查询参数保留）；去尾斜杠与 `#fragment`；http→https。同一规范 URL 的多条合并，片段拼接，去重。

## 3. 片段预筛（代码版，Jev 之前）

- query 实词集 = query 去停用词后的 token（中英文各自分词，中文按字符二元）。
- 片段删除条件（同时满足）：不含任何 query 实词或 intent 实词；长度 < 200 字符。这类几乎全是导航标题（例：mezha 页里的 "Moldova Explains…"、"Pentagon Estimates…"）。
- 样板文字删除：以 "Continue after ad"、"Share"、"Release Time:"、"READ MORE"、"Cite this article"、"## Frequently Asked Questions" 这类行开头且不含 query 实词的短片段；cookie/newsletter 提示。列表放常量文件，可增补。
- 页内重复：同一来源内两片段 5-gram Jaccard > 0.8 只留第一条（标题+导语常被抽两次）。

## 4. 事实指纹增量新颖度（替代"指纹重合率"）

- 指纹元素：数字（含单位/货币前后缀，如 `$40 million`、`0.042`、`70-500ms`、`193.6x`）、日期串、专有名词（连续大写词组、中文书名号/引号内容）、引号内原文（≥ 6 词）。
- 按 Brave 顺序遍历来源：`novel = fp(source) − ∪fp(已幸存来源)`。
- 判为改写稿并丢弃：`|novel| < NOVELTY_MIN`（初值 2）且 `|fp(source)| ≥ 4`（有足够事实可比）。事实太少的短来源不在此丢，交给 Jev 的 filler 判定。
- 日志记录每个来源的 novel 集合，便于事后审阅"它独有的是什么"。
- 已知边界：措辞完全不同但事实相同的两篇，第二篇会被丢；这是期望行为。独有引语（mezha 的 Mudholkar/Ronacher 引语）算 novel，会被保留。

## 5. 手工黑名单

- 文件 `blocklist.txt`，一行一个规范 host，只收"结构上就是农场"的站（GitHub issue 镜像、SO 镜像、纯聚合站）。混合平台永不入列。
- 候选提示：日志里某 host 在 ≥ N 次搜索中每次都被 Jev 判 filler 且从未被判 reasoning/primary，脚本列出，人工加入。

## 6. 裁回预算

- 模型请求的 `maximum_number_of_urls` 与 `maximum_number_of_tokens` 视为输出上限。幸存来源按 Brave 序取前 N；总 token 超预算时从最后一个来源开始砍片段（不砍来源顺序）。
- 超量倍数默认 1×（老大 2026-09-19），环境变量 `OVERFETCH_FACTOR` 保留；>1 时只放大 urls 与 total tokens，**不放大 per-url tokens**。

## 7. 状态行

追加到 `content` 文本末尾（不是 JSON 内），一行：`[filter] dropped 4 sources: 2 rewrite, 1 filler, 1 blocklist; 17 snippets removed (9 nav, 5 jsonld-meta, 3 dup)`。无丢弃时不附。

## 8. 输出形状

与上游相同的 JSON 字符串（grounding.generic + sources），sources 只留 title/hostname/age[0]（沿用补丁行为）。不返回 structuredContent，不声明 outputSchema。

## 测试夹具

- `fixtures/jev_release_default.json`：12 源 76 片段 30.9k 字符，5 个 JSON-like 片段，含中文改写页（winzheng）、乌克兰语站英文版（ua.news、mezha）、FAQ 农场（pasqualepillitteri、explainx）、转载快讯（kucoin）、官方博客、两篇原创报道（register、heise）。
- `fixtures/jev_release_strict.json`：同查询 strict 模式，41 片段 18.0k 字符。
- 每条规则的期望结果先手工标注到 `fixtures/expected_*.json`，再写测试。
