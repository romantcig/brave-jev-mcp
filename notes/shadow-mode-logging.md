# 影子模式、兜底与日志格式（草案）

## 三档模式

环境变量 `JEV_FILTER_MODE`：
- `off`：只跑本地规则层；Jev 不调用。阶段一默认。
- `shadow`：Jev 照常调用、照常计算裁决、照常写日志，但输出仍是本地规则层的结果（不真丢）。
- `on`：Jev 裁决生效。

## 兜底

- 单来源请求失败（超时、429/529 重试耗尽、422、网络）只影响该来源：按"留"处理（等价于对它只跑本地规则），其余来源照常裁决。状态行计入"Jev 未判定 n"，日志记 `jev_status`。
- 请求级超时初值 **15 s**（本机直连实测尾延迟为官方标称数倍，5 s 会频繁掐掉）。
- 熔断：失败计数跨请求累计，连续 3 次开 60 s，期间只跑本地规则并裁回预算。
- 无候选（本地规则删光）不调 Jev，请求数记 0。
- 进程级并发闸，初值 6，超出排队。
- 配置校验：环境变量阈值非数字回落默认值，负数截到 0；坏值不能让整层静默失效。
- 超限阶梯（发送前估算，见 notes/jev-api.md）：① JSON-LD 元数据与导航片段已删 → ② 按 Brave 序砍尾部片段 → ③ 去掉片段级 score 题只留来源级 noul → ④ 该来源不问 Jev。每级记级别名进 stats。
- 统计对象：过滤库返回 `{result, stats}`，状态行和日志都从同一个 stats 生成。

## 逐请求日志（JSONL，按天滚动，目录 `JEV_FILTER_LOG_DIR`，默认 `~/.brave-jev/logs/`）

一条记录一个搜索请求：

```
ts, mode, model_reported, jev_backend,
request: {query, intent, urls, tokens, per_url, freshness, threshold_mode},
brave: {latency_ms, n_sources, n_snippets, chars, api_version},
local: {jsonld_converted, jsonld_dropped, url_merged, snippets_prefiltered, dup_removed, novelty:[{src, fp_total, novel:[...]}], blocklist_hits},
jev: {n_requests, input_tokens, latency_ms_total, status, per_source:[{src, url, answers:{...全部原始概率}, snippet_scores:[...], verdict, reason}]},
output: {n_sources, n_snippets, chars, status_line},
shadow_diff: {would_drop:[src...], would_remove_snippets:n}   # 仅 shadow
```

隐私：日志只在本机；不上传。片段正文不全量入日志，只存 URL、标题、指纹与概率；需要复看正文时用 fixtures 或重新抓。

## 影子期审核流程（由我做）

1. 每天读日志，汇总 `would_drop` 清单与每源六题概率。
2. 抽样人工判，尺子用 notes/labeling-rubric.md：误杀（有独有信息却 would_drop）、漏杀（filler/rewrite 却 KEEP）。
3. 画每题概率分布，看误杀集中在哪个区间，定阈值。
4. 比较 `worth_keeping` 直接题 vs 维度题组合的误杀率（对照用）。
4b. 专门统计：高 has_original_reasoning 的来源里自我标榜型农场页占比；stale 丢弃里官方文档占比。
5. 中文来源单独统计。
6. 模型名变化 → 用 fixtures 重跑 `dev/jev_probe.py`，比较裁决翻转数。

## 阈值常量（初值，全部待影子期修订）

```
OFF_TOPIC_DROP     = 0.85
LISTING_DROP       = 0.80
SELF_DEPRECATED    = 0.70
STALE_DROP         = 0.85
FILLER_DROP        = 0.80   且 has_original_reasoning < REASONING_PROTECT
REASONING_PROTECT  = 0.70   高于此的来源片段免于新颖度删除
PRIMARY_SEED       = is_primary 降序作指纹播种顺序
SNIPPET_MIN        = 1.0    score 低于此的片段删除（0 档=导航/元数据）
CJK_BONUS          = +0.10  来源 CJK 占比 > 0.5 时，各丢弃门槛加此值
MIN_FACTS          = 4      片段指纹数低于此不做重复判定
NOVELTY_MIN        = 2
JEV_TIMEOUT_MS     = 15000
（is_attributed_rewrite 无阈值：只记日志作确认信号，不参与裁决）
```

网关差异提醒：Vercel 的 boolean 答案字段是 `probability`，直连/OpenRouter 的 noul 答案字段是 `noul`；choice/score 的 confidence 在 Vercel 走 providerMetadata。适配层统一后再进裁决。
