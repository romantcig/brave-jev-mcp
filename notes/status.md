# 项目状态与待办（每次会话结束前原地重写，不追加）

更新：2026-09-20（GSD 路线图建成后）

## 当前处于哪一步

阶段零完成，阶段一**未开工**。GSD 初始化全部完成：`.planning/` 下 PROJECT.md、config.json、REQUIREMENTS.md（44 条 v1 需求）、ROADMAP.md（4 个 Phase）、STATE.md 都已入库，分支 `jev`。

GSD 的 4 个 Phase 与 PLAN 第 4 节的对应：

| GSD Phase | 内容 | 对应 PLAN 第 4 节 |
|---|---|---|
| 1 Embed and Local Rules | 纯库嵌入、工具声明加必填 `intent`、本地规则层对夹具按标注通过 | 阶段一步 1–3、5 |
| 2 Jev Client and Verdicts | 三后端客户端、裁决顺序、兜底、环境变量配置面、对比工具 | 阶段一步 4、6 |
| 3 Logging and Cutover | 状态行、JSONL 日志、stdio 冒烟、切 `~/.claude.json`、补丁脚本退役 | 阶段一步 7–8 |
| 4 Shadow Period and Go-Live | 影子期、审核脚本、定阈值切 `on`、模型回归、推 GitHub 前检查 | 阶段二 |

## 下一会话从这里开始

1. 读本文、PLAN.md、`.planning/STATE.md`。
2. `/gsd-progress` 会路由到 Phase 1 的 discuss 或 plan。PLAN 与 notes 已经是 Phase 1 的完整上下文，可以直接 `/gsd-plan-phase 1`：不动 `src/`，只在 `.planning/phases/01-*/` 下产出 RESEARCH / PATTERNS / PLAN。
3. 执行 Phase 1（`/gsd-execute-phase 1`）前必须先拿到老大改 `src/` 的一句授权。

## 卡点

- 老大尚未授权改代码（执行 Phase 1 的前置，计划 Phase 1 不受影响）。
- PLAN 第 6 节待老大：拿不准时留还是删；一次搜索多等数秒是否接受；中文搜索占比。
- Phase 2 的回放用例需要能入库的 `.jev.json` 样本（现有的全部 gitignore），脱敏还是合成由计划阶段定。

## 待办（按顺序）

1. [ ] 计划 Phase 1（可不等授权）。
2. [ ] 取得改代码授权 → 执行 Phase 1。
3. [ ] Phase 2、Phase 3 依次计划与执行；Phase 3 切 `~/.claude.json` 前先备份。
4. [ ] Phase 4 影子期：跑几天 → 按 labeling-rubric 审核 → 定阈值 → on。
5. [ ] 推 GitHub 前跑一遍 `grep` 确认公开文件无 Jev 数字、无 key（SHADOW-05）。

## 已验证可用（定性）

- 直连、OpenRouter 协议、Vercel 网关三条路都探通；直连 6 并发无限流。Vercel 免费档对并发即 429。
- 题库在 12 源样本上方向正确：正面题分明，否定性题偏温和。数字见 notes/private-jev-evidence.md。
- Brave strict 模式会砍锐评段，不默认开。两版夹具在 `fixtures/`。
- token 估算公式在英文夹具上可用，需加余量。

## GSD 相关约定

- 配置：yolo、coarse、顺序执行、智能体继承会话模型、跳过项目级调研（`.planning/config.json`）。
- `.planning/` 入库（commit_docs = true），所以 ROADMAP / STATE / 各 Phase 的 PLAN 里同样不能出现 Jev 数字。
- `.claude/CLAUDE.md` 是 GSD 生成的项目指令文件，已手工裁成三节（项目摘要、代码地图指针、工作流约束）。再跑 `generate-claude-md` 会把代码地图整段（约 48 KB）灌回来，跑完记得再裁。
- 决策权威仍是 PLAN.md 第 5 节：改决策先改那里，记 `notes/decisions-log.md`，再同步 `.planning/PROJECT.md` 的 Key Decisions 表。

## 文件地图

| 位置 | 内容 |
|---|---|
| PLAN.md | 当前态：原则、路线、架构、阶段、决策表、待定 |
| .planning/ | GSD 工件：PROJECT / REQUIREMENTS / ROADMAP / STATE / config，codebase/ 是上游 2.1.4 的代码地图 |
| .claude/CLAUDE.md | GSD 生成的项目指令文件（已裁剪） |
| notes/README.md | 笔记索引与归属规则 |
| notes/decisions-log.md | 决策变更日志（旧结论去处） |
| notes/history/ | 按日期归档的过程记录，只读 |
| notes/private-*.md | 不入库：Jev 数字、本机环境 |
| dev/fetch_fixture.py | 抓真实 Brave 响应到 fixtures/ |
| dev/jev_probe.py | 对夹具跑 Jev 题库，题库与阈值在文件顶部 |
| fixtures/ | 真实 Brave 响应（默认/strict）、Sanity 六组、noise 样本；`*.jev.json` 不入库 |
| 远端 | 配置里只有 `upstream`（brave/brave-search-mcp-server，PLAN 第 3.5 节），2026-09-20 已 fetch，`merge-base jev upstream/main` 可用；`origin/*` 引用是原始克隆残留、指向同一仓库，无 `origin` 远端，公开仓库建好后再加 |
