# Brave Jev MCP

[English](https://github.com/romantcig/brave-jev-mcp/blob/release/README.md) | 简体中文

联网搜索时，返回的内容常混着垃圾文章，以及提到了关键词却回答不了问题的段落。这些内容会占用上下文，也让 AI 需要从更多无关信息中寻找答案。

**项目在搜索结果交给 AI 之前，先筛掉其中无用的页面和片段，让 AI 把更多上下文留给真正能帮助回答问题的内容。**

项目基于 [Brave Search MCP Server](https://github.com/brave/brave-search-mcp-server)：Brave 负责搜索网页、提取内容，[Jev](https://typesafe.ai/) 负责结合搜索目的进行筛选。留下的内容仍然带有来源链接，并保持 Brave 的原始顺序，方便 AI 阅读、回答和引用。

过滤功能目前仅适用于 `brave_llm_context`。其他搜索工具仍可使用，但不经过本项目的过滤层，也不会调用 Jev 进行筛选。

普通网页搜索（`brave_web_search`）主要返回链接和短摘要，供人判断是否点开网页；`brave_llm_context` 则提供从网页中提取的内容片段，让 AI 可以直接阅读。在我们的实测中，`brave_llm_context` 的信息密度明显更高，能直接用于回答的内容也更多。因此，即使不开启过滤，我们仍推荐使用 `brave_llm_context`。

## 安装接入

需要准备：

- [Node.js](https://nodejs.org/)。
- [Brave Search API 密钥](https://brave.com/search/api/)，需要绑定信用卡，每月提供 5 美元免费额度，按当前价格可用于 1,000 次搜索。
- [Jev API 密钥](https://typesafe.ai/)，用于过滤。

建议将 `BRAVE_API_KEY`（Brave 密钥）和 `TYPESAFE_API_KEY`（Jev 密钥）设为环境变量，并确保 AI 客户端将它们传入 MCP 进程。程序会自动读取这两个变量；如客户端需要显式传递，请使用其环境变量配置功能。

在 AI 客户端中添加下面的配置，`npx` 会自动下载并启动：

```json
{
  "mcpServers": {
    "brave-jev": {
      "command": "npx",
      "args": [
        "-y",
        "@romantcig/brave-jev-mcp@latest",
        "--transport",
        "stdio",
        "--enabled-tools",
        "brave_llm_context"
      ]
    }
  }
}
```

示例使用 `@latest` 获取 npm 上发布的最新版。

`--enabled-tools` 用于选择向 AI 开放的工具。上面的配置仅开放 `brave_llm_context`；需要其他工具时，可将工具名作为独立的字符串追加到该参数后。未设置其他工具筛选选项时，移除该参数及其工具名即可开放全部工具。

其他工具有：

- 网络搜索（`brave_web_search`）：主要返回网页链接和短摘要，内容丰富程度对比 `brave_llm_context` 有明显不足。
- 本地搜索（`brave_local_search`）：搜索本地商家和地点。
- 新闻搜索（`brave_news_search`）：搜索最新新闻文章，支持时效性筛选并提供突发新闻标记。
- 地点搜索（`brave_place_search`）：根据地名或坐标搜索商家、地点、地址和街道。
- AI 摘要（`brave_summarizer`）：调用旧版 Summarizer API，需要已有的 Pro AI 套餐订阅；Brave 已推出替代它的 Answers API，但此工具尚未接入。
- 视频搜索（`brave_video_search`）。
- 图像搜索（`brave_image_search`）。

首次启动时，程序会自动创建 `~/.brave-jev/config.json`，默认开启过滤；已有配置会继续使用。Brave 密钥是搜索所必需的。暂未配置 Jev 密钥时，搜索仍然可用，但会跳过 Jev 过滤，并在需要过滤的结果中提示如何配置。

MCP 的启动参数、环境变量、过滤配置和程序版本均在启动时加载，变更后需要重启 MCP 才会生效。

## 接入后怎么用

向 AI 描述需要查找的内容。例如：

> 使用 Brave MCP 的 `brave_llm_context` 比较 SQLite 和 PostgreSQL。我想为一个单机应用选择数据库，重点了解部署复杂度、并发写入限制和适用场景，请附上来源。

为单机应用选择数据库时，并发限制和部署方式有用，泛泛介绍“选择数据库很重要”的段落则帮助不大。开启 Jev 过滤后，AI 会把关键词和搜索目的分别传给工具，把自己的需求说清楚即可。

## 默认搜索预算

为了避免 AI 未指定限制时返回过多内容，让大量讲述同一件事的来源占满上下文，`brave_llm_context` 使用以下默认预算：

| 参数 | 默认值 | 含义 |
| --- | ---: | --- |
| `count` | 10 | 挑选上下文的候选搜索结果数 |
| `maximum_number_of_tokens` | 4000 | 近似总 token 预算 |
| `maximum_number_of_tokens_per_url` | 800 | 单个来源的 token 预算 |
| `maximum_number_of_urls` | 5 | 返回来源数上限 |

这些默认值在所有过滤模式下生效。需要更多来源或细节时，可以在调用工具时调整相应参数；`count` 是候选结果数，不是最终返回的来源数。

搜索结果会先经过本地规则清理，再交给 Jev 结合搜索目的筛选。若未配置 Jev 密钥或 Jev 请求失败，MCP 仍会返回已完成本地清理的内容，但不会完成 Jev 的语义筛选。

## 其他说明

- [过滤层配置指南（中文）](https://github.com/romantcig/brave-jev-mcp/blob/release/FILTERING.md)：配置、运行模式、阈值和日志。
- [技术说明（中文）](https://github.com/romantcig/brave-jev-mcp/blob/release/MECHANISMS.md)：三片组合过滤、临界阈值补偿和结果核对。
