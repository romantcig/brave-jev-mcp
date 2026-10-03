/**
 * 过滤规则版本常量（04-04 R4）：可定位真实过滤实现的标识，与 package.json 的包
 * 版本（filter_program_version）分开记录——包版本跨多次过滤实现变更不变，无法
 * 回放"某次裁决用的是哪一版规则"。
 *
 * 方案取舍（R4 二选一，选源码受控常量、弃构建时注入 git commit）：
 * - dist/ 是 src/ 的确定性编译产物，常量与**实际运行的代码**严格同体——不存在
 *   "运行时读 HEAD、旧 dist 张冠李戴"的问题（报告点名的禁忌）；
 * - Docker / 无 .git 环境照样可得；不需要给 `npm run build`（tsc + shx）加生成
 *   步骤；git 方案要解决"构建时把 commit 固化进产物"的额外机制，收益相同。
 *
 * 递增纪律：凡改变过滤决策语义的改动（本地规则、Jev 裁决、新颖度、超限阶梯、
 * 预算截断等）必须递增本值并在 git 提交信息里注明——回放时按值定位实现区间；
 * 题库改动不在此处（已有 QUESTION_SET_ID 哈希锚点，改题必须重调 Jev）。
 *
 * 版本不可得时（理论上不可能：常量在编译单元内）样本层回落 'unknown'，绝不拿
 * 包版本号冒充实现标识。
 */

/** 15 = GitHub 本地清洗更新：撤下搜索块与反应状态行；加入 PR Uh oh!、仓库纯 Topics
 *  卡片与 About 完整包含回声；成对比较提示扩展至 Release 列表页。管道顺序、
 *  全局 shingle 门槛和题库不变，退役动作名只兼容读取旧样本。
 *  14 = 时间上下文试运行接入（2026-10-03，TEMPORAL_CONTEXT_SCORING_ROLLOUT_PLAN）：
 *  新增开关 `jev.temporal_context`（默认 false 精确保留旧行为，关闭即完整回退）——
 *  开启时 Jev state 携带 `retrieval_time`（宿主在 Brave 请求前捕获一次，同一次搜索
 *  的 all、single 回退与重试共用）与每来源 `brave_page_date`（原 Brave 元数据 age
 *  选出、归并冲突置 null），all 模式片段评分题换用第二十五轮实测、第二十六轮冻结的
 *  时间上下文新题（QUESTION_SET_ID 随题库哈希自动更新）；single（含 all 回退）沿用
 *  旧评分题、仅加时间字段。预算检查在完整日期与新题加入后才做（32k/64k、15% 余量
 *  不变）；不恢复 stale/self_deprecated/time_snip{i}/年份选择器/0.85 时间门槛，不
 *  新建"超过多少天就删"规则，删除原因仍是 score。
 *  13 = 步 3「短且无实词」nav 预筛退役（2026-10-03）：长度 < 200 且不含
 *  query ∪ intent 实词的片段不再在本地删除——第二十四轮消融实证该条件误伤参数、
 *  功能与硬件支持四段真实内容（撤条件后四段均获 Jev 高于删除线评分并完整保留）；
 *  空片段删除与步 8 一句话来源的 query 实词兜底保留，片段级质量判断交 Jev 评分。
 *  12 = 删除片段级时间题机制整块（time_snip{i} 题构造条件、0.85 门槛、年份
 *  选择条件、裁决消费、投影防御、砍尾连带删题、样本记账字段，2026-10-03）：日常
 *  29 次搜索发出 117 道时间题仅 1 次触发删除，77 份 test 样本 45 道 0 道过线——
 *  片段不再因时间错位被删，评分、去重与来源级规则照常生效（QUESTION_SET_ID
 *  随题库自动更新）。
 *  11 = 删除来源级 stale 与 self_deprecated 两道门槛题及其阈值（2026-10-03 题库
 *  再精简：386 次来源裁决统计 stale 零触发；self_deprecated 触发 5 次、4 次明确
 *  误删——题干四条件与报道弃用事件的叙述天然撞车），来源级丢弃门槛五道收缩为
 *  三道，裁决校验同步收缩为四键（QUESTION_SET_ID 随题库自动更新）。
 *  10 = 代码跨度外正确处理反斜杠转义，跨度内仍按字面量处理，修复 R1b 误删。
 *  9 = 步 3 GitHub 界面清洗返修（审查 R1/R2）：缩进代码保护改按缩进列数判定
 *  （Tab 按 CommonMark tab stop 展开，单 Tab / 混合缩进不再误放行）、保护扩入跨行
 *  内联代码跨度（开启行/内部行/闭合行整体不删）与引用段落的懒续行；清洗增加幂等
 *  验证——删除后重判仍命中（删除接壤制造的新块）则整轮保守放弃，不循环到固定点；
 *  分支引用要求冒号后有分支名。五条规则本身不变。8 = 步 3 样板行剥离阶段接入
 *  GitHub 平台界面文字局部清洗（GITHUB_CLEANUP_PLAN
 *  首批五条：仓库导航行、分支复制按钮后缀、搜索界面连续块、版本比较成对提示、
 *  反应按钮状态行；仅对 github.com 仓库首页 / PR / Issue / Discussion / Release
 *  tag 页生效，围栏、缩进代码、引用、内联代码内不触发；test/on 应用、off 不应用；
 *  动作明细进统计表 SnippetStats.github_cleanup 与 LocalStats.github_cleanup_actions，
 *  样本 format_version 4 的可选键，读取向后兼容）。7 = Jev 请求组织接入六题全量
 *  上下文（`jev.context_mode`，默认 single 不改变既有行为）：all 模式全候选共享
 *  一次请求、按显式映射投影答案、双限额预检与整批回退；请求账目与样本格式 v4
 *  随之变更（FULL_CONTEXT_ROLLOUT_PLAN）。6 = 步 3 样板行剥离扩入标题重复行
 *  （≥2 次才剥、代码区域豁免）与引用块剥离（书目签名、首段事实保护及完整小节
 *  检查），样板前缀表增补 CTA 条目；乱码碎词原型经审核证实误删真实代码（审核 F1）
 *  撤下未接入。5 = 来源题精简为六道并取消当事方播种排序（去重与输出统一 Brave
 *  原序）；4 = 带年份片段的时间判断；3 = 明确非一手组稳定排序及页面/栏目名单。 */
export const FILTER_RULES_VERSION = 'filter-rules-15';

/** 单来源 source / 全量 sources[i] 与 s{id}__题键的首版布局；题意另由题库 ID 标识。
 *  2 = 时间上下文字段进入 state（`retrieval_time` 顶层、每来源 `brave_page_date`），
 *  all 模式片段评分题换用冻结新题（TEMPORAL_CONTEXT_SCORING_ROLLOUT_PLAN §5）；题键
 *  与数组位置语义不变。 */
export const CONTEXT_LAYOUT_ID = 'jev-context-2';
