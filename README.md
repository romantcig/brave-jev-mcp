# Brave Jev MCP

English | [简体中文](https://github.com/romantcig/brave-jev-mcp/blob/release/README_CHINESE.md)

Web search results often contain junk articles and passages that mention the right keywords without answering the question. This material consumes context and leaves the AI to find answers among unrelated information.

**This project removes unhelpful pages and snippets before search results reach the AI, leaving more context for information that can help answer the question.**

Built on [Brave Search MCP Server](https://github.com/brave/brave-search-mcp-server), the project uses Brave to search the web and extract content, and [Jev](https://typesafe.ai/) to filter it according to the purpose of the search. Retained content keeps its source links and Brave's original ordering so the AI can read, answer, and cite it.

Filtering currently applies only to `brave_llm_context`. Other search tools remain available, but their results do not pass through this project's filtering layer or call Jev for screening.

Regular web search (`brave_web_search`) mainly returns links and short summaries that help people decide which pages to open. In contrast, `brave_llm_context` provides content snippets extracted from web pages for the AI to read directly. In our testing, `brave_llm_context` delivers significantly higher information density and more material that can directly support an answer. We therefore recommend `brave_llm_context` even with filtering disabled.

## Installation

Prepare the following:

- [Node.js](https://nodejs.org/).
- A [Brave Search API key](https://brave.com/search/api/). A credit card is required. The API provides $5 in free monthly credits, covering 1,000 searches at the current Search plan price.
- A [Jev API key](https://typesafe.ai/) for filtering.

We recommend setting `BRAVE_API_KEY` (your Brave key) and `TYPESAFE_API_KEY` (your Jev key) as environment variables and ensuring that your AI client passes them to the MCP process. The server reads these variables automatically. If your client requires explicit forwarding, use its environment variable settings.

Add the following configuration to your AI client. `npx` downloads and starts the package automatically:

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

The example uses `@latest` to get the latest version published on npm.

`--enabled-tools` selects which tools are exposed to the AI. The configuration above exposes only `brave_llm_context`. To enable more tools, append their names as separate strings after this argument. If no other tool filtering options are set, removing the argument and its tool names exposes all tools.

Other tools include:

- Web search (`brave_web_search`): mainly returns page links and short summaries, with significantly less detailed content than `brave_llm_context`.
- Local search (`brave_local_search`): searches for local businesses and places.
- News search (`brave_news_search`): searches recent news articles, supports recency filters, and provides breaking news indicators.
- Place search (`brave_place_search`): searches for businesses, places, addresses, and streets using place names or coordinates.
- AI summaries (`brave_summarizer`): calls the legacy Summarizer API and requires an existing Pro AI plan subscription. Brave has introduced Answers API as its replacement, but this tool has not integrated it.
- Video search (`brave_video_search`).
- Image search (`brave_image_search`).

On first launch, the server creates `~/.brave-jev/config.json` with filtering enabled by default. Existing configuration is preserved. The Brave key is required for search. Without a Jev key, search still works, Jev filtering is skipped, and results that would otherwise be filtered include setup instructions.

The MCP server loads its startup arguments, environment variables, filtering configuration, and program version at startup. Restart it for changes to take effect.

## Usage

Tell the AI what you need to find. For example:

> Use Brave MCP's `brave_llm_context` to compare SQLite and PostgreSQL. I am choosing a database for a single-machine application. Focus on deployment complexity, concurrent write limits, and suitable use cases, and include sources.

When choosing a database for a single-machine application, concurrency limits and deployment methods are useful; a generic passage about why choosing a database matters contributes little. With Jev filtering enabled, the AI sends search keywords and search intent separately to the tool. You only need to describe what you need.

## Default search budgets

To prevent excessive output when the AI omits explicit limits, and to keep sources repeating the same information from filling the context, `brave_llm_context` uses these defaults:

| Parameter | Default | Meaning |
| --- | ---: | --- |
| `count` | 10 | Candidate search results considered when selecting context |
| `maximum_number_of_tokens` | 4000 | Approximate total token budget |
| `maximum_number_of_tokens_per_url` | 800 | Token budget per source |
| `maximum_number_of_urls` | 5 | Maximum number of returned sources |

These defaults apply in every filtering mode. Adjust the relevant parameters when calling the tool if you need more sources or detail. `count` is the number of candidate results, not the number of sources ultimately returned.

Search results first pass through local cleanup rules, then go to Jev for screening against the search intent. If the Jev key is missing or the Jev request fails, the MCP server still returns the content after local cleanup, but Jev's semantic screening is not completed.

## Further reading

- [Filter configuration guide (Chinese)](https://github.com/romantcig/brave-jev-mcp/blob/release/FILTERING.md): configuration, operating modes, thresholds, and logging.
- [Filtering mechanisms (Chinese)](https://github.com/romantcig/brave-jev-mcp/blob/release/MECHANISMS.md): three-snippet combination filtering, near-threshold compensation, and inspecting results.
