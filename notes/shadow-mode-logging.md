# 影子模式与日志格式（草案）

## 三档模式

环境变量 `JEV_FILTER_MODE`：
- `off`：只跑本地规则层；Jev 不调用。阶段一默认。
- `shadow`：Jev 照常调用、照常计算裁决、照常写日志，但输出仍是本地规则层的结果（不真丢）。
- `on`：Jev 裁决生效。

任何 Jev 错误（超时、429/529 重试耗尽、422、网络）→ 该次请求退化为 `off` 行为，日志记 `jev_status`。熔断：连续 3 次失败开 60s，期间不调 Jev。

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
2. 抽样人工判：误杀（有独有信息却 would_drop）、漏杀（filler/rewrite 却 KEEP）。
3. 画每题概率分布，看误杀集中在哪个区间，定阈值。
4. 比较 `worth_keeping` 直接题 vs 维度题组合 的误杀率，定主判据。
5. 中文来源单独统计。
6. 模型名变化 → 用 fixtures 重跑 `dev/jev_probe.py`，比较裁决翻转数。

## 阈值常量（初值，全部待影子期修订）

```
OFF_TOPIC_DROP   = 0.85
FILLER_DROP      = 0.80   且 has_original_reasoning < 0.5
KEEP_MIN         = 0.50   worth_keeping 低于此且 is_attributed_rewrite > 0.5 → 丢
SNIPPET_MIN      = 1.0    score 低于此的片段删除（0 档=导航/元数据）
CJK_BONUS        = +0.10  来源 CJK 占比 > 0.5 时，各丢弃门槛加此值
NOVELTY_MIN      = 2
```

网关差异提醒：Vercel 的 boolean 答案字段是 `probability`，直连/OpenRouter 的 noul 答案字段是 `noul`；choice/score 的 confidence 在 Vercel 走 providerMetadata。适配层统一后再进裁决。
