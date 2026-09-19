# Jev 接口事实（核实日期 2026-09-19）

来源：docs.typesafe.ai（api、models、state、primitives、confidence、jaggedness）、typesafe-sdk-js 类型定义、vercel/ai gateway 源码、typesafe-jev-examples、本机探测。

## 模型是什么

- 不生成文本。输入 state（字符串 / JSON 对象 / 文本数组）+ 一组带名字的问题，输出每题一个类型化答案。所有问题并行、互相隔离地对同一 state 评估，多加问题几乎不增加延迟。
- 三种问题类型：

| 类型 | 输入 | 输出 | 限制 |
|---|---|---|---|
| noul | instructions，可选 criteria `{true, false}` | `noul` 0–1，表示"是"的概率。**没有 confidence 字段** | 正向措辞，高概率 = 是 |
| choice | instructions，criteria `{选项: 描述或 null}` | `choice`、`probabilities`（和为 1）、`confidence` | 1–255 个选项 |
| score | instructions，criteria 有序档位数组 | `score`（概率加权位置，可落在档位之间）、`probabilities`、`legend`、`confidence` | 2–10 档；每档单独评估，模型看不到档位编号和相邻档 |

- instructions 和 criteria 都接受 JSON 对象/数组；多部分问题官方建议写成带键名的对象（如 `{question, inspect, focus}`）。
- 问题 key 不送模型，题干必须自含完整语义。用反引号路径引用 state 里的字段，如 `source.snippets[2]`。
- 答案概率四舍五入到两位小数。
- 响应带 `model`（实际版本 ID）和 `usage.input_tokens`。

## 限额与错误

- 单请求：state + 全部问题 ≤ 64k token；state + 最长单题 ≤ 32k token。**超限直接拒绝**（422 类），不是截断。
- 速率：250k token/s，1200 请求/分；官方声明限额动态调整。
- 错误码：401 鉴权；422 请求体校验失败（会指出字段）；429 限流；529 过载。429/529 用指数退避重试。
- 输入只有文本。英文最好；CJK "handled but not equally well"。挪威语实测约 2.06 字符/token，中文按 1 字符/token 保守估算。
- 版本：`jev-latest` 随发布移动；官方建议"调好阈值后钉版本 ID，自己择时迁移"。当前 `jev-1.13.0`。

## 三条接入路径

### A. TypeSafe 直连（需 waitlist key）

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
{"model":"jev-latest","state":...,"questions":{...}}
→ {"model":"jev-1.13.0","answers":{...},"usage":{"input_tokens":N,"output_tokens":0}}
```

### B. OpenRouter（预付费账号即可）

```
POST https://openrouter.ai/api/alpha/decisions
Authorization: Bearer $OPENROUTER_API_KEY
{"model":"typesafe/jev-1.13","state":...,"questions":{...}}
```

- 请求体与响应体和路径 A **完全相同**（noul/choice/score 原样）。
- 钉版 ID `typesafe/jev-1.13-20260917`。模型页显示 context_length 32000。
- 无 key 探测返回 401（端点存在）。chat/completions 端点不接受该模型。

### C. Vercel AI Gateway（每月 $5 免费额度，需绑卡）

```
POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model
Authorization: Bearer $AI_GATEWAY_API_KEY        # vck_ 开头
ai-gateway-protocol-version: 0.0.1
ai-gateway-auth-method: api-key
ai-evaluation-model-specification-version: 4
ai-model-id: typesafe-ai/jev
Content-Type: application/json
{"state":...,"questions":{...},"providerOptions":{...可选}}
→ {"answers":{...},"usage":{...},"rounding":{...},"warnings":[],"providerMetadata":{"typesafe":{"confidence":{...}}}}
```

- **协议差异**：问题类型用 `boolean` 代替 `noul`；boolean 答案形状 `{type:"boolean", probability}`；choice/score 的 confidence 不在答案里，在 `providerMetadata.typesafe.confidence[questionId]`。
- 模型 ID 走 `ai-model-id` 头，不在请求体里。
- 支持逐请求 ZDR / no-training（providerOptions）。
- 本机探测记录（2026-09-19）：缺协议头 → 400 "Unsupported gateway protocol version"；补齐头后 → 403 `customer_verification_required`，要求账号绑信用卡才解锁免费额度。绑卡后免费档每月 $5，首次使用生效，不买 credits 不扣费。
- 探测脚本：`~/.zcode/tmp/260919-053010/jev_gateway_probe.py`（从用户级环境变量 `Vercel_API_KEY` 读 key）。

### 本项目客户端的抽象

内部统一用原生形状（noul）。适配层做两件事：路径 C 发送前 noul→boolean、接收后 `probability`→`noul` 并把 providerMetadata 里的 confidence 合并回答案；路径 A/B 原样透传。后端由环境变量选择。

## 法务要点（MCA，2026-09-19 版本）

- 2.3(f) 禁止发布关于服务的 benchmark 或性能信息 → 公开仓库不放任何 Jev 准确率、延迟、成本对比数字。
- 2.3(a) 禁止把服务作为独立服务转售 → 我们的 MCP 服务器是自用应用，不对外提供 Jev 调用，不触碰。
- 4.1 不用客户数据训练；企业档可 ZDR；Vercel 网关可逐请求 ZDR。
- 输入数据的经手方：TypeSafe，加上所走的网关（Vercel 或 OpenRouter）。
