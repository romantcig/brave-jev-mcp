# Jev 页面过滤配置

`brave_llm_context` 可通过 `JEV_FILTER_CONFIG_FILE` 环境变量指定本地 JSON 配置。密钥继续使用环境变量 `TYPESAFE_API_KEY`。配置在 MCP 进程初始化时读取，修改后需要重连或重启对应 MCP。

最小配置只需过滤模式一项；向既有配置合并即可，其余设置保持原值：

```json
{
  "mode": "test"
}
```

`test` 与 `on` 使用同一条实际过滤链；`test` 还保存过滤前响应、最终返回、实际 Jev 请求、回答和身份映射。`off` 只跑本地规则，不请求 Jev。旧值 `shadow` 是 `test` 的兼容别名。

Jev 请求组织只有一种：全部候选共享一次请求（all）。曾经的双开关 `jev.context_mode` 与 `jev.temporal_context` 已于 filter-rules-16 退役——遗留配置里出现这两个键按未知键忽略，不需要清理也能运行，但它们不再改变任何行为。

## 请求契约（filter-rules-16 起）

- 零候选：零次 Jev 逻辑调用与 HTTP，不构造空问题请求。
- 一个或多个候选：本地步骤 1–4 之后的完整候选数组进入同一次共享请求（`state.sources[]`，保持 Brave 原序）；只有一个候选也走同一模板，没有单候选特殊路径。
- 一次搜索最多一次 Jev 逻辑请求。没有 single 回退、没有超限降级、没有本地 `too_large` 分类：发送前不做 token 估算预检，不删正文、不删题、不拆请求。载荷超过官方限额时依赖服务端拒绝——HTTP 413／422 按通用非重试 `validation` 处理，相关来源保守保留。
- 同一搜索的重试复用完全相同的 body、检索时间和题目；重试属于同一逻辑请求。
- 逐题错误隔离是唯一解析语义：单个坏答案不使其他来源的有效答案失效；顶层协议错误仍整请求失败。
- 超时、重试、退避、Retry-After、熔断与进程级并发闸照旧。
- 回答桩可 `answered` 而未派发（无 fetch 证据）：计零请求，载荷保持 null。

## 时间上下文与题库

时间上下文字段常开，没有开关：

- `retrieval_time`：宿主发起 Brave 请求前捕获的那一个时刻，带时区的 ISO 字符串；缺失或非法时省略，不补"今天"。纯过滤库与回放不读当前时间。
- 每个候选带 `brave_page_date`（`string | null`）：从原 Brave 元数据 `age` 中选择，优先合法绝对时间，再选合法 `YYYY-MM-DD`，保留原字串。相对时间不倒推；非法日期、缺失日期、合并来源日期冲突统一为 `null`。日期不进公开 MCP 参数或 Brave 查询参数。

页面日期只是发表或更新线索，不代表项目维护时间，也不代表所有内容失效。评分题根据需求时期、事件状态以及候选材料中的同事件后续证据打分；历史需求与仍适用的技术说明仍可能保留。没有跨来源覆盖删除或最终参照复核。

题库（QUESTION_SET_ID `0ef644dda1ad`）：

- 来源级四题：`has_original_reasoning`、`is_template_filler`、`is_off_topic`、`is_listing`。
- 片段级：每个候选片段一道时间上下文评分题。
- 总题数 = 候选数 × 4 + 片段数。

四道来源题、原创论证保护、Brave 原序、十步管道和既有去重不变。片段仍是三档 score，默认 `thresholds.snippet_min = 1.00`，严格小于才删除，原因仍记为 `score`。没有独立时间题、年份选择器或按页面年龄删除的门槛。

## v5 样本核对方法

当前样本 `format_version` 为 5，规则与布局版本为 `filter-rules-16`、`jev-context-3`。核对一次实际搜索：

1. 样本根字段 `format_version: 5`。
2. `config_snapshot.jev` 只含 `model`、`timeout_ms`、`concurrency` 三键；`context_mode`／`temporal_context` 不再出现在新样本里。
3. 请求级记录 `jev.requests` 一次搜索至多一条：`request_id`、`source_ids`、`dispatched`／`answered`／`usage_complete`、真实 `input_tokens`、`mapping`；字段中没有 `mode`、`requested`、`effective`、`fallback_reason`、`planned_estimates`。`n_requests` ≤ 1，`n_http_attempts` 单独记真实 HTTP 尝试（含重试）。
4. `question_set_id` 为 `0ef644dda1ad`，`filter_rules_version` 为 `filter-rules-16`。

旧样本按其自身 `format_version` 读取，不迁移、不改写：

| 版本 | 载荷与映射                                                                             | 读取时的边界                                                                                              |
| ---- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| v1   | `sent` 段在输入降级前重建，片段只有单一 `sent` 布尔                                    | 不能作为实际发送内容或有效评分的证据；没有规则版本字段                                                    |
| v2   | 从派发处捕获输入，`sent[].state` 是逐来源字符串                                        | `scored` 仍可能由题数推断，不能当作有效评分证据                                                           |
| v3   | 仍是逐来源 state；逐题记录有效评分，分开 `score_applied` 与来源裁决有效性              | 不能把 `sent[].state` 当作请求级共享载荷                                                                  |
| v4   | `requests[]` 保存每次逻辑请求的载荷，`sent[]` 经 `request_id` 引用；新增 HTTP 尝试计数 | 请求带 `mode`，可能逐来源多条；配置可能包含 `context_mode` / `temporal_context`，不能套用 v5 的单请求约束 |
| v5   | 只使用全量共享请求，一次搜索至多一条；请求记录去掉模式、回退与预估字段                 | 未派发的载荷为 null；Jev 配置只含模型、超时和并发；未派发原因仅 `skipped` / `breaker_open`                |

`dispatched` 表示 fetch 已调用，不保证服务端收到或处理；`in_state`、`score_question_sent`、`answered`、`scored` 与 `score_applied` 分别表示不同阶段的事实，不能互相代替。缺答或无效评分不能从题目数量推断成“已评分”。

核对生效版本应查看配置快照、实际请求记录和保存的题目，不能只凭题库 ID 判断。

## 回退与关闭

- 关闭 Jev 过滤：`mode: "off"`，重启目标 MCP。只保留本地规则层，Jev 完全不参与。
- 没有配置级回退到旧评分题或 single 请求：备用题库与回退路径不在新代码内。若要回滚代码，使用此前完整构建版本（git 历史），不做手工拼接。

已知的观察项继续保留：Redlib 旧测量残留、Grok 参数冲突与纠错、Gemini 争议反证、Sanity 独有技术细节，以及交易报道的混合条款仍需观察；工程验证不代表这些问题全部解决，也不代表已经证明总体误删率低于 4%。

## GitHub 本地清洗

filter-rules-15 接入的 GitHub 本地清洗在现行版本保留：`test/on` 下、送入 Jev 前处理以下内容，`off` 不应用这些 GitHub 专属规则：

| 页面                      | 清理范围                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------- |
| 仓库首页                  | 仓库导航行；独立 About / Topics 标签卡片；被同来源前序本地幸存文本完整包含的 About 简介 |
| PR 详情                   | 当前仓库分支引用后的复制按钮文字；独立 `Uh oh!` 行                                      |
| Release 列表与具体 tag 页 | 相邻成对的 `Choose a tag to compare` / `No results found`，允许间隔空行                 |

`search_block` 和 `reactions_unavailable` 不再执行。`Conversation`、真实许可证、提交表格及混有实质正文的 Topics 片段保留。代码与引用区域受保护，幸存文本保持原序。

About 去重只压缩空白后做完整包含，不用模糊语义相似，也不降低全局短文本门槛。只清理完整的简介卡片，允许前置空 License / Configuration 标题；真实许可正文、链接或额外内容不随卡片删除。该判定使用当前本地步骤已保留的前序文本，不宣称后续 Jev 裁决冻结不变。

新动作记为 `pr_uh_oh`、`repo_topics`、`about_echo`，沿用样本的 `github_cleanup` 字段及原片段行号。About 回声删除原因记为 `dup`；纯 Topics 卡片删除记为 `boilerplate`。清洗后的文本同时进入 Jev 与最终重建链。
