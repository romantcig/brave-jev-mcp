# 项目状态与待办（每次会话结束前更新）

更新：2026-09-19（拿到直连 key 后）

## 当前处于哪一步

阶段零完成。**直连 key 已到**（`jev_API_KEY`），12 源与 Sanity 样本已跑，PLAN 升到 v2（第 13 节）。阶段一**仍未开工**：老大要求改代码前把第 13.4 节的待讨论项过完并明确授权。分支 `jev`，首个提交只含文档、脚本、夹具；`src/filter/` 里 5 个误开工骨架文件未提交。

## 下一会话从这里开始

老大要求：代码工作放到新会话。开工前先读 PLAN.md 第 7 节决策表、第 13 节，以及 notes/dedup-and-rewrite-policy.md、notes/non-article-pages.md，然后等老大一句授权再动 src。

## 本轮已定

见 PLAN 第 7 节末尾新增行与第 13 节。要点：裁决改"保留题不达标才丢"；stale / self_deprecated / paywalled 三道新题；空来源、付费墙走代码；strict 不默认开；Jev 数字只进 private 笔记。

## 已验证可用

- Vercel AI Gateway 调 Jev **通了**：绑卡后单次请求 HTTP 200，`dev/jev_probe.py` 的题库形状被接受，boolean/score 答案与 providerMetadata.typesafe.confidence 都按预期返回。单请求 12 源样本约 1.2k–1.7k 输入 token、1.5–3s。
- 单篇样本上题库表现符合直觉：The Register 的 has_original_reasoning 0.94、is_primary 0.04；kucoin 转载快讯 is_attributed_rewrite 0.62；winzheng 中文改写 is_attributed_rewrite 0.90；导航/元数据片段被 score 判到 0–1 档（0.6），正文片段 ~2.0。**这些只是三篇的印象，不是结论。**
- Brave `context_threshold_mode=strict` 实测：同一查询 12 源，片段 76→41、字符 30.9k→18.0k（减 42%），来源集不变。JSON-LD 块 5→4。说明 strict 主要砍每来源的次要片段，不改来源选择。两版夹具都在 `fixtures/`。

## 已解决的卡点

- Vercel 免费档并发 429 的问题因直连 key 到位而绕过。`dev/jev_probe.py` 已支持直连（有 `jev_API_KEY` 即走直连，6 并发）。Vercel 后端保留为备选。

## 待办（按顺序）

1. [x] 直连 key 到位，12 源与 Sanity 样本已跑（数字在 private 笔记）。
1b. [ ] 过完 PLAN 第 13.4 节待讨论项，取得老大改代码授权。
2. [ ] 阶段一：按 PLAN.md 第 5 节开工。顺序：`npm install && npm run build` 验证构建 → 在 `execute()` 后插过滤管道骨架（off 模式直通）→ 本地规则层（JSON-LD 分流、URL 归并、片段预筛、事实指纹增量新颖度）→ 移植补丁脚本的声明改动 → 夹具测试 → stdio 冒烟 → 切 `~/.claude.json` → 补丁脚本退役。
3. [ ] Jev 客户端三后端（直连 / OpenRouter / Vercel），先写好，走 off 模式。
4. [ ] 影子模式日志格式定稿。
5. [ ] 拿到 key 后：影子几天 → 定阈值 → on。

## 文件地图

| 位置 | 内容 |
|---|---|
| PLAN.md | 方案与决策记录（第 7 节决策表是唯一权威） |
| notes/README.md | 笔记索引 |
| notes/jev-api.md | Jev 接口、三条接入路径精确请求形状、法务 |
| notes/jev-question-writing.md | 写题规则、cookbook 先例、题库草案 |
| notes/brave-llm-context.md | Brave API 参数与上游服务器结构 |
| notes/private-jev-evidence.md | 社区实测数字（gitignore） |
| notes/status.md | 本文件 |
| dev/fetch_fixture.py | 抓真实 Brave 响应到 fixtures/ |
| dev/jev_probe.py | 对夹具跑 Jev 题库，题库与阈值集中在文件顶部 |
| fixtures/jev_release_default.json / _strict.json | 同一查询默认与 strict 两版真实响应 |
| fixtures/*.jev.json | Jev 原始答案（含探测未完成的残缺版） |
| ~/.zcode/tmp/260919-053010/ | 临时目录：docs/（官方文档与 cookbook 副本、HN 全串）、repos/（官方 SDK、skills、adapter、社区先例仓库） |
