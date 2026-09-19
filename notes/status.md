# 项目状态与待办（每次会话结束前原地重写，不追加）

更新：2026-09-19（v3 文档重构后）

## 当前处于哪一步

阶段零完成，阶段一**未开工**。直连 key 已到，12 源与 Sanity 样本已跑，PLAN 已升 v3（文档重构 + 裁决逻辑修订）。分支 `jev`。

## 下一会话从这里开始

1. 读 PLAN.md（13 KB，只有当前态）。
2. 开工前再读 notes/dedup-and-rewrite-policy.md、notes/shadow-mode-logging.md、notes/labeling-rubric.md。
3. 等老大一句授权再动 `src/`。

## 卡点

- 老大尚未授权改代码。
- PLAN 第 6 节两项待老大：拿不准时留还是删；一次搜索多等数秒是否接受。

## 待办（按顺序）

1. [ ] 取得改代码授权。
2. [ ] 阶段一，按 PLAN 第 4 节八步。
3. [ ] 影子期日志格式定稿（notes/shadow-mode-logging.md 现为草案）。
4. [ ] 影子几天 → 按 labeling-rubric 审核 → 定阈值 → on。
5. [ ] 推 GitHub 前跑一遍 `grep` 确认公开文件无 Jev 数字。

## 已验证可用（定性）

- 直连、OpenRouter 协议、Vercel 网关三条路都探通；直连 6 并发无限流。Vercel 免费档对并发即 429。
- 题库在 12 源样本上方向正确：正面题分明，否定性题偏温和。数字见 notes/private-jev-evidence.md。
- Brave strict 模式会砍锐评段，不默认开。两版夹具在 `fixtures/`。
- token 估算公式在英文夹具上可用，需加余量。

## 文件地图

| 位置 | 内容 |
|---|---|
| PLAN.md | 当前态：原则、路线、架构、阶段、决策表、待定 |
| notes/README.md | 笔记索引与归属规则 |
| notes/decisions-log.md | 决策变更日志（旧结论去处） |
| notes/history/ | 按日期归档的过程记录，只读 |
| notes/private-*.md | 不入库：Jev 数字、本机环境 |
| dev/fetch_fixture.py | 抓真实 Brave 响应到 fixtures/ |
| dev/jev_probe.py | 对夹具跑 Jev 题库，题库与阈值在文件顶部 |
| fixtures/ | 真实 Brave 响应（默认/strict）、Sanity 六组、noise 样本；`*.jev.json` 不入库 |
