# 过滤层配置指南与行为契约

本文档说明 `brave_llm_context` 的现行过滤配置、题目设计、本地清洗与样本核对方式。过滤层仅接入 `brave_llm_context`；其他搜索工具不经过本地清洗或 Jev 筛选，本文的配置、过滤状态与样本记录不适用于它们。

## 一、配置与运行模式

默认读取 `~/.brave-jev/config.json`，文件不存在时自动创建，内容为 `{"mode":"on"}`；已有文件保留原值。可选环境变量 `JEV_FILTER_CONFIG_FILE` 覆盖此路径，自定义路径需自行创建文件。配置缺项或坏值回落内置默认值，默认模式为 `on`。

在 MCP 客户端配置中，将 `TYPESAFE_API_KEY` 放入此服务器的 `env` 对象，值为 Jev 密钥；过滤 JSON 不保存密钥。宿主初始化后缓存配置与分类器，修改配置、密钥或重新构建后，需要重启对应 MCP。

- `off`：运行本地基础清洗，不调用 Jev；GitHub/X 专用界面清洗不启用，工具描述与参数均不包含 `intent`。
- `test`：完整过滤链实际改变返回内容，并保存完整调试样本。
- `on`：与 `test` 使用相同裁决链，保存统计日志，不额外保存完整样本。

`on/test` 且密钥可用时，工具要求必填 `intent`；缺少或空白密钥时使用不含 `intent` 的搜索定义，并在搜索结果的错误状态行中提示配置密钥或关闭 Jev 的方法。工具定义在启动时确定，不热更新。`tool_description_file` 仅在 Jev 可用时覆盖主描述，参数声明不受其影响。

最小配置为 `{"mode":"on"}`。未指定的设置使用默认值：

```json
{
  "mode": "on",
  "log_dir": "~/.brave-jev/logs",
  "jev": {
    "model": "jev-1.13.0",
    "timeout_ms": 15000,
    "concurrency": 12
  },
  "thresholds": {
    "filler_drop": 0.8,
    "group_keep_min": 0.25,
    "single_keep_min": 0.5
  }
}
```

三项阈值均接受 `[0,1]` 内的有限数。配置使用上面的 snake_case 键名；坏值逐项告警并回落默认，未知键忽略。组大小固定为三，不提供组大小配置。

三项阈值之外另有一条固定的临界裁决规则（不作为配置项）：有效概率未命中原删除条件、但与门槛的差距不超过 `0.02` 时同样删除，没有最小距离。距离上限包含端点（如页面 `0.78` 对门槛 `0.80`），比较时只容忍双精度机器尾差，不改动任何概率本身。某项阈值恰为 `0` 或 `1` 时该项只执行原判定，不启用临界补偿；三项分别判断。

## 二、本地处理与输出

搜索预算省略时，宿主在发给 Brave 前补齐 `count: 10`、`maximum_number_of_urls: 5`、`maximum_number_of_tokens: 4000`、`maximum_number_of_tokens_per_url: 800`，所有过滤模式共用。各项独立补默认值，显式传入的合法数值保留，不按其他预算自动重算。日志记录生效预算；自动补默认值不生成参数调整提示。

工具描述建议常规调用省略预算，只有已有结果显示来源覆盖或片段细节不足时再增加。参数声明展示默认值，不展示上下限数字；运行时仍校验整数与上限，低于下限时抬至合法值并返回调整提示。

本地先处理 JSON-LD，再剥离结构化样板和空片段。GitHub/X 界面清洗只在 `test/on` 启用。不执行通用文本去重；GitHub About 简介已被前序正文完整包含时可剥离。新增本地规则须有高频、明显且经过日志核验的特征，实测触发频率低于 1% 的规则不予保留。

模型判断完成后清理空来源，保持 Brave 原始来源与片段顺序。最终返回压缩后的内容及必要的状态行，不输出 MCP `structuredContent`。

## 三、共享请求与题目

一次搜索的全部非空候选共享一个 `state`，只发一次逻辑请求；网络重试属于这次逻辑请求。零候选不调用 Jev。端点为 `https://api.typesafe.ai/v1/systemone`，默认模型固定为 `jev-1.13.0`。

- `state.query` 和 `state.intent` 表达检索主题与信息需求。
- `state.retrieval_time` 使用宿主发起 Brave 检索前捕获的时间；缺失或非法时省略，不补当前时间。
- `state.sources[]` 按 Brave 原序包含全部幸存候选。每个来源保存 `id/url/title/snippets/brave_page_date`，未知页面日期为 `null`。
- 原始来源 ID 与数组位置分开记录。`snippet_keys` 保留原片段索引及 JSON-LD 拆片身份，重复 URL 不合并。

### 页面题

每来源只有一道 noul 题 `sN__filler`，判断正文是否主要为无具体事实的套话或标题拼装，且缺少作者带理由的评价、批评、比较或论证。作者分析保护已经包含在这道题的题意中。

有效概率达到 `filler_drop` 时整页删除，原因 `filler`；门槛位于 `(0,1)` 内时，低于门槛但差距不超过 `0.02` 也删除，来源统计行携带实际补偿距离 `near_threshold_gap`（原判定删除不带此键）。页面答案缺失、错型、非有限或越界时保守保留页面并记录 `validation`，有效片段答案仍可独立裁决。

### 片段组合题

同来源连续片段最多三个一组，题键为 `sN__group0`、`sN__group3` 等，不跨来源分组。每组字母从 A 重新开始，每个片段仍独立判断。题目要求保留能回答意图的事实、技术解释、比较与实例，删除导航、样板、偏离方向的内容、只有主题名称的片段和被确认事件替代的过时预测。

| 组大小 | 选项顺序 | 逐片保留门槛 |
| --- | --- | --- |
| 三片 | none, A, B, AB, C, AC, BC, ABC | 0.25 |
| 两片 | none, A, B, AB | 0.25 |
| 单片 | none, A | 0.5 |

选项的 criteria 值均为 `null`，顺序按位掩码递增。单片使用专用短题干。每片保留概率为所有包含其字母的选项概率之和；单片直接取 `P(A)`。低于门槛时删除，原因 `keep_probability`；门槛位于 `(0,1)` 内时，达到门槛但高出不超过 `0.02` 也删除（包含 `gap = 0`），片段统计行携带实际补偿距离 `near_threshold_gap`。其余有效片段保留；门槛为 `0` 或 `1` 时，恰达门槛保留。不舍入、不重新归一化，不按最大选项或模型标签直接决定删留。

choice 概率必须是非数组对象，标签齐全且无额外标签，每值有限且在 `[0,1]`，概率和满足 `abs(sum-1) < 0.06`。这是客户端本地接受范围。坏答案只使所属组保守保留，不左移片段位置、不影响其他组；有效页面删除仍可删除包含坏组的来源。幸存来源存在无效组合题时，状态行提示检查未完成，页面裁决的有效性仍单独记录。

## 四、失败处理

无密钥、网络超时、重试耗尽、请求被拒或熔断时，保留已经过本地清洗的候选。分类器共享并发限制与熔断状态。请求是否派发、是否回答、HTTP 尝试次数和用量完整性分别记录；输入 tokens 按请求累计一次，不按来源重复计算。

## 五、GitHub 本地清洗

| 页面类型 | 清理内容 |
| --- | --- |
| 仓库首页 | 仓库导航、独立 Topics 卡片、前序正文已完整包含的 About 简介 |
| PR 详情 | 分支引用后的复制按钮残留、独立 Uh oh! 报错行 |
| Release 列表 | 相邻的 Choose a tag to compare 与 No results found 占位块 |

清理保留代码、引用与有效正文，动作明细写入逐片统计。

## 六、运行日志与样本落盘

过滤统计逐请求追加写入 `log_dir/YYYY-MM-DD.jsonl`，按本地日期滚动；依赖 OS 单行追加的原子性，多会话同写互不影响，写入失败只打标准错误日志，绝不影响搜索结果。成功记录包含 `ts`、`mode`、`model_config`/`model_reported`、`thresholds`、只读规则快照 `decision_rules` 与 `filter_rules_version`、`request_id`、`test` 模式下的 `sample` 指针，以及统计主体（`request`、`brave`、`local`、`jev`、`output`）。Brave 上游或协议校验失败时改记 `error`（`stage: brave | schema`）与当次请求参数，不写统计主体。

`test` 模式样本另落盘于 `log_dir/samples/YYYY-MM-DD/`，仅存本机仓库外目录，不含认证头或环境变量。公开发布或提交前检查 Git 跟踪文件，确保无真实 API 密钥硬编码。

## 七、样本核对

当前样本格式 `8`，规则版本 `filter-rules-23`，布局版本 `jev-context-4`。题库哈希覆盖页面题、一/二/三片完整模板与选项顺序；阈值通过配置快照记录。

1. `pre_filter` 保存完整原始响应，`final_return` 保存实际返回载荷与状态行。
2. `jev.requests` 保存实际派发的 state、questions、解析后的 answers 和 mapping。完整共享载荷只存一份，保存时不重新构造请求。
3. `mapping` 中的 `source_id/array_index/snippet_keys/question_keys/snippet_groups` 对齐原始身份、候选位置和组合字母。
4. `jev.sent[].snippets[]` 保存实发题键、题型、字母、是否实发、答案有效性、无效原因、本地派生的 `keep_probability`、门槛、`applied` 与最终 `verdict/reason`；片段确实应用了临界裁决时另带 `near_threshold_gap`（含 0）。页面已删时，片段答案可以有效，但 `applied` 为 false；片段裁决导致来源最后变空时，已经应用的片段答案仍为 true。
5. `config_snapshot.decision_rules` 是只读运行规则快照（含 `near_threshold_max_gap`），描述该构建的裁决规则，不是可写进设置文件生效的配置组；JSONL 成功与错误记录顶层也写同形 `decision_rules` 和 `filter_rules_version`。快照本身不证明本次执行了临界裁决，实际命中以逐项 `near_threshold_gap` 为准；`off`、无密钥和失败路径不产生临界命中。
6. 完整 choice 分布和模型标签只在请求级样本中保存，状态行与 JSONL 不保存正文或完整分布。

读取样本时先区分 `format_version`。格式 7 的逐片 score 与格式 8 的保留概率含义不同，不能互相解释。格式 8 允许缺少 `decision_rules` 和 `near_threshold_gap`，缺少规则快照时结合 `filter_rules_version` 判断裁决语义。真实回放必须同时匹配正文、题干、题键和选项顺序；请求变化后需要重新录制，原始录制保持不变。
