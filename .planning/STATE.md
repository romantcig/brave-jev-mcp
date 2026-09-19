---
gsd_state_version: '1.0'
status: planning
progress:
  total_phases: 4
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-09-19)

**Core value:** `brave_llm_context` 每次返回的来源，都是对 intent 有独立信息价值的页面：一手来源、原创论证、独有事实留下；转述、模板、列表页、旧版页去掉；拿不准时保守，宁可多留。
**Current focus:** Phase 1 - Embed and Local Rules

## Current Position

Phase: 1 of 4 (Embed and Local Rules)
Plan: 0 of 0 in current phase
Status: Not started / awaiting authorization to edit src/
Last activity: 2026-09-20 — 路线图与状态文件创建，4 个阶段，44 条 v1 需求全部映射

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**
- Total plans completed: 0
- Average duration: -
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**
- Last 5 plans: -
- Trend: -

*Updated after each plan completion*

## Accumulated Context

### Decisions

决策权威是 `PLAN.md` 第 5 节：改决策先改那里的对应行，旧结论记 `notes/decisions-log.md`，再同步 PROJECT.md 的 Key Decisions 表。本文件只摘要。
影响当前工作的决策：

- [Phase 1]: 挂载点 A2 源码嵌入；过滤层是不含 MCP 类型的纯库，`execute()` 只留几行适配；对上游只动三处（EMBED-06）
- [Phase 1]: 模式缺省 `off`；`off` 模式跳过 Jev，指纹播种按 Brave 序；过滤后为空就返回空，不补回
- [Phase 1-2]: 判据为页面粒度，不看域名与是否官方；黑名单只收结构性农场且手工加入；管道十步顺序固定，幸存者保持 Brave 原序
- [Phase 2]: Jev 只做门槛不重排；单来源一次请求、并行、进程级并发闸；钉版本 ID；跨来源比较放代码；单来源失败按"留"
- [All]: 公开文件不含任何 Jev 性能数字（MCA 2.3(f)）；key 只走环境变量；顺序执行，一次只开一个智能体（API 限额）

### Pending Todos

None yet.

### Blockers/Concerns

- [Phase 1 前置] 改 `src/` 前需老大明确授权，目前尚未取得。这是执行 Phase 1 前的阻塞项
- [待老大定，PLAN 第 6 节] 拿不准时留还是删（现默认保守）；一次搜索多等数秒是否接受；中文搜索占比（决定中文样本优先级）
- [待影子期定，Phase 4] 各阈值与 CJK 门槛（初值在 `notes/shadow-mode-logging.md`）；农场页自我标榜是否抬高论证题；stale 丢弃里官方文档占比
- [Phase 2] 现有 `fixtures/*.jev.json` 不入库，JEV-07 的回放用例需要能入库的样本（脱敏或合成），落法由计划阶段定
- [Phase 3] `~/.claude.json` 切换改的是老大机器上的配置，先备份再改

## Deferred Items

Items acknowledged and deferred at milestone close, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| *(none)* | | | | |

## Session Continuity

Last session: 2026-09-20
Stopped at: ROADMAP.md 与 STATE.md 已写，REQUIREMENTS.md 追溯表已填；等老大审阅路线图并授权改 `src/`
Resume file: None
