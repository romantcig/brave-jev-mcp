# 非文章页：列表页、feed、付费墙、元数据页（2026-09-19）

依据：老大提供的 FT、WSJ 两个样本（付费墙）、Apple Podcasts 样本（元数据页）、Substack 样本（付费预览）。样本文件在 `fixtures/noise/`。

## 类别重新划分

原方案把"付费墙"当一个类别，假设页面会有"订阅后继续阅读"之类标记。真实样本推翻了这个假设：

- FT 样本不是文章页，是栏目列表页：三条片段是三篇不同文章的日期 + 标题 + 导语，"Premium content" 只是其中一条的标签。
- WSJ 样本的来源 URL 是 Dow Jones 的 RSS feed，片段是 WSJ 链接、时间戳、内部编号、一句摘要，两条片段是两篇不同文章。

真正的类别是**"这一页不是一篇文章"**：栏目列表页、RSS feed、标签页、搜索结果页、只剩预览的付费文章、只有元数据的媒体条目页。付费墙只是产生这些页面的原因之一。

## 处理

| 信号 | 层 | 做法 |
|---|---|---|
| URL 含 `rss`、`feed`、`.xml`，或域名以 `feeds.` 开头 | 代码 | 直接判 feed，丢来源 |
| 片段是多个独立条目（各有日期 / 标题 / 链接，互不连贯） | Jev noul `is_listing` | "`source` 是多篇独立文章的列表（标题、日期、链接），不是一篇文章的正文" |
| "Premium content"、"Subscriber only"、"付费会员专享"、"This post is for paid subscribers" 等标记 | 代码标记列表 | 只做片段级：从标记处截断该片段；不据此判整页 |
| 页面声明后续需付费 / 订阅 | Jev noul `paywalled` | 与截断配合；预览段常已含论点，不整页丢 |
| 只有媒体元数据（标题、时长、分类、日期），无正文或听录稿 | 现有链 | 片段级评分 0 档 → 片段删光 → 空来源规则删除；用样本验证，漏了再加 noul |
| 片段删光 | 代码 | 丢来源，同步清理 sources 表条目 |
| 只剩一条短片段 | 代码 | 不含 query 实词删，含实词留 |

## 状态行

这些丢弃在状态行里分别计数（feed / listing / paywall / empty / metadata），模型看到"3 个来源是列表页"应换更具体的关键词，看到"付费墙"应知道原文不可得、转述即为唯一版本（见 dedup-and-rewrite-policy.md）。

## 标记列表初值

英文：Premium content、Subscriber only、Subscribers only、This post is for paid subscribers、Subscribe to continue reading、Sign in to read、Members only、Continue reading with a subscription。
中文：付费会员专享、以下为付费内容、订阅后阅读全文、会员可见、加入会员查看。
老大有新写法随时补。
