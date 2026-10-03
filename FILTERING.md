# Jev 页面过滤与时间上下文试运行

`brave_llm_context` 可通过 `JEV_FILTER_CONFIG_FILE` 环境变量指定本地 JSON 配置。密钥继续使用环境变量 `TYPESAFE_API_KEY`。配置在 MCP 进程初始化时读取，修改后需要重连或重启对应 MCP。

下面是时间上下文日常试运行的最小配置；向既有配置合并这些字段即可，其余设置保持原值：

```json
{
  "mode": "test",
  "jev": {
    "context_mode": "all",
    "temporal_context": true
  }
}
```

`temporal_context` 默认 `false`，只接受布尔值，错误类型会警告并回落为 `false`。`test` 与 `on` 使用同一条实际过滤链；`test` 还保存过滤前响应、最终返回、实际 Jev 请求、回答和身份映射。`off` 不请求 Jev。

| 配置与实际路径 | 时间输入 | 片段评分题 |
| --- | --- | --- |
| `temporal_context: false` | 不添加时间字段 | 原有评分题，完整功能回退 |
| `true`，实际 all | 检索时间与各来源页面日期 | 第二十五、二十六轮冻结的时间上下文评分题 |
| `true`，实际 single，包括 all 回退 | 同一检索时间与该来源页面日期 | 原有单来源评分题 |

检索时间在 Brave 请求前捕获一次，以带时区的 ISO 字符串传入 `retrieval_time`。日期不会进入公开 MCP 参数或 Brave 查询参数。回放必须使用原日志时间或保存的实际 state；纯过滤库不读取当前日期补齐缺失值。

页面日期 `brave_page_date` 从原 Brave 元数据 `age` 中选择：优先合法绝对时间，再选合法 `YYYY-MM-DD`，保留原字串。相对时间不倒推，非法日期、缺失日期记为 `null`。合并来源的日期不同或部分未知时统一为 `null`，避免把一个页面的日期归给另一个页面。

页面日期只是发表或更新线索，不代表项目维护时间，也不代表所有内容失效。新题根据需求时期、事件状态以及候选材料中的同事件后续证据评分；历史需求与仍适用的技术说明仍可能保留。实际 all 候选材料不等于最终存活材料，本功能没有加入跨来源覆盖删除或最终参照复核。

四道来源题、原创论证保护、Brave 原序、十步管道和既有去重不变。片段仍是三档 score，默认 `thresholds.snippet_min = 1.00`，严格小于才删除，原因仍记为 `score`。未恢复独立时间题、年份选择器或按页面年龄删除的门槛。完整时间和题目先进入载荷，再按既有 32k／64k 限额与 15% 余量检查；all 超限时回退 single。

当前版本为 `filter-rules-15`、`jev-context-2`、题库 `e307a770fb87`，模型保持 `jev-1.13.0`。时间上下文在规则版本 14 接入，版本 15 调整 GitHub 本地清洗。样本容器仍为 v4，旧样本无需迁移。核对生效分支应查看配置快照、实际请求模式和保存的题目，不能只凭题库 ID 判断。

这是可回退的日常试运行。Redlib 旧测量残留、Grok 参数冲突与纠错、Gemini 争议反证、Sanity 独有技术细节，以及交易报道的混合条款仍需观察；工程验证不代表这些问题全部解决，也不代表已经证明总体误删率低于 4%。

优先回退方法：将 `jev.temporal_context` 改成 `false`，重启目标 MCP，并在新样本中确认 state 不再带时间字段、评分题回到原模板。`context_mode: "single"` 只改变请求组织，仍保留时间输入；`mode: "off"` 则会同时关闭其他 Jev 过滤。

## GitHub 本地清洗

规则版本 15 在 `test/on` 下、送入 Jev 前处理以下内容，`off` 不应用这些 GitHub 专属规则：

| 页面 | 清理范围 |
| --- | --- |
| 仓库首页 | 仓库导航行；独立 About / Topics 标签卡片；被同来源前序本地幸存文本完整包含的 About 简介 |
| PR 详情 | 当前仓库分支引用后的复制按钮文字；独立 `Uh oh!` 行 |
| Release 列表与具体 tag 页 | 相邻成对的 `Choose a tag to compare` / `No results found`，允许间隔空行 |

`search_block` 和 `reactions_unavailable` 不再执行。`Conversation`、真实许可证、提交表格及混有实质正文的 Topics 片段保留。代码与引用区域受保护，幸存文本保持原序。

About 去重只压缩空白后做完整包含，不用模糊语义相似，也不降低全局短文本门槛。只清理完整的简介卡片，允许前置空 License / Configuration 标题；真实许可正文、链接或额外内容不随卡片删除。该判定使用当前本地步骤已保留的前序文本，不宣称后续 Jev 裁决冻结不变。

新动作记为 `pr_uh_oh`、`repo_topics`、`about_echo`，沿用样本的 `github_cleanup` 字段及原片段行号。About 回声删除原因记为 `dup`；纯 Topics 卡片删除记为 `boilerplate`。清洗后的文本同时进入 Jev 与最终重建链。
