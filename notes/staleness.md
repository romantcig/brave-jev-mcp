# 版本过时与自称废弃（2026-09-19 定稿）

本文件是"内容过时"这一类的唯一权威说明。证据数字见 notes/private-jev-evidence.md，推导过程见 notes/history/2026-09-19-sample-review.md 第 13.2 节。

## 为什么纯代码判不了

Sanity 六组真实样本（`fixtures/sanity/`）显示：旧内容体现在**语法时代**（`sanity.json` 插件数组、`part:@sanity/*` 导入属 v2），不在版本号。多数旧教程根本不写版本号。版本号正则在这批样本上失效。

代码没有产品历史知识，调用模型有；Jev 能做的是字面核对"这页的做法和 intent 点名的现行做法是不是同一套"。

## 分工

1. **调用模型**在 `intent` 里点名当前版本及标志性机制。工具描述加一条规则，建议句：
   > If the query concerns a versioned product, name the current version and its defining mechanism in `intent` (e.g. "current Sanity Studio (v6, sanity.config.ts based)").
2. **Jev** 对每个来源问两道独立 noul：
   - `stale`：`source` 里的代码或配置针对的是比 `intent` 点名版本更旧的做法，且没有同时展示现行做法。
   - `self_deprecated`：`source` 自称已废弃、归档、被别的工具取代、不再维护。
3. **代码**按各自门槛丢弃。`self_deprecated` 的门槛可以低于 `stale`，因为那是页面自己说的。

## 写法 A 与写法 B

- 写法 A：intent 只点名版本和机制。
- 写法 B：另附 `context.obsolete` / `context.current` 机制清单。
- 试跑结果：两个 v2 毒源在两种写法下都被高概率判旧，官方文档全部低概率；B 分离度更高但要模型多写一段，且 B 抓不到"README 自称被取代"这种信号。**先用写法 A**，影子期不够再加 B 的 context 字段。

## 不丢的情况

- v3 时代但语法仍兼容 v6 的第三方教程：Jev 给中间概率，**不丢**，交给增量新颖度处理，与官方文档重叠时自然去掉。
- "官方来源质量更高"不采用为规则，页面粒度原则不变；官方性已由 `is_primary` 作为保留加分项。

## 已知风险与缓解

过滤器在这一项上依赖调用模型的先验，而搜索恰恰是为了纠正先验。模型点名了错误的"当前版本"时，真正现行的页面可能被判旧。缓解：

- `stale` 门槛设高，只丢高把握。
- 状态行回显依据：`2 sources dropped as stale relative to "<intent 点名的版本>"`，模型看到自己点错了版本可以去掉版本声明重搜。
- 影子期专门统计 stale 丢弃里官方文档的占比，非零即说明门槛或题干有问题。
