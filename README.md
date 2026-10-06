# Brave Jev MCP

English | [简体中文](https://github.com/romantcig/brave-jev-mcp/blob/release/README_CHINESE.md)

When an AI searches the web, the results often include generic articles, site navigation, and passages that mention the right keywords without answering the question. This material consumes context and leaves the AI to find answers among unrelated information.

**This project removes unhelpful pages and snippets from `brave_llm_context` results before they reach the AI, leaving more context for information that can help answer the question.**

Built on [Brave Search MCP Server](https://github.com/brave/brave-search-mcp-server), the project uses Brave to search the web and extract content, and [Jev](https://typesafe.ai/) to filter it according to the purpose of the search. Retained content keeps its source links and Brave's original ordering so the AI can read, answer, and cite it.

**Filtering scope: only `brave_llm_context` uses this project's filtering layer. Other search tools remain available, but they do not support this filtering or call Jev to screen their results. The filtering configuration, status messages, and debugging samples described below apply only to `brave_llm_context`.**

## Installation

Prepare the following:

- [Node.js](https://nodejs.org/), preferably 24 LTS.
- A [Brave Search API key](https://brave.com/search/api/) for search.
- A [Jev API key](https://typesafe.ai/) for filtering.

The package is available on [npm](https://www.npmjs.com/package/@romantcig/brave-jev-mcp). Add it to your AI client with the configuration below. `npx` downloads and starts the package automatically; no source checkout or manual build is needed. This example is for clients that use a `mcpServers` JSON configuration:

```json
{
  "mcpServers": {
    "brave-jev": {
      "command": "npx",
      "args": ["-y", "@romantcig/brave-jev-mcp@0.1.0", "--transport", "stdio"],
      "env": {
        "BRAVE_API_KEY": "Your Brave Search API key",
        "TYPESAFE_API_KEY": "Your Jev API key"
      }
    }
  }
}
```

Replace the two API key placeholders with your own keys. The configuration pins version `0.1.0` for predictable behavior. To follow the latest release, replace `@0.1.0` with `@latest` and restart the MCP server when updating. For clients with a different configuration format, use the same command, arguments, and environment variables.

On first launch, the server creates `~/.brave-jev/config.json` with filtering enabled by default. Existing configuration is preserved. The Brave key is required for search. Without a Jev key, search still works, Jev filtering is skipped, and results that would otherwise be filtered include setup instructions. Restart the MCP server after changing keys or configuration.

## Usage

Tell the AI what you need to find. For example:

> Use Brave Jev MCP's `brave_llm_context` to compare SQLite and PostgreSQL. I am choosing a database for a single-machine application. Focus on deployment complexity, concurrent write limits, and suitable use cases, and include sources.

When the AI calls this project's `brave_llm_context`, search, content extraction, and filtering happen within that call. The AI receives filtered web snippets and source links, then uses them to compose its answer. It can visit the original pages for further verification. If your client has multiple search tools, you can explicitly ask the AI to use this project's `brave_llm_context`.

**Explaining why you are searching helps the filter match your actual needs.** When choosing a database for a single-machine application, concurrency limits and deployment steps are useful; a generic passage about why databases matter contributes little. The AI sends search keywords and search intent separately to the tool. You only need to describe what you need.

Default search counts and content budgets are provided for everyday use. Adjust them when you need more sources or detail. If Jev is temporarily unavailable, the server returns search content after local cleanup.

### Inspecting filtered results

To see what a search removed, set `mode` to `test` in `~/.brave-jev/config.json`, then restart the MCP server:

```json
{ "mode": "test" }
```

Each `brave_llm_context` call then saves a local sample and includes its file path in the returned result. Here is an actual filter status message, with the local path replaced by a placeholder:

```text
[filter] 4 snippets removed sample for filter debugging - original results, filtered results, Jev decisions: <local sample path>
```

This status means four snippets were removed. The path points to the complete sample for that search. If you think useful content was removed or clearly unhelpful content was retained, ask an AI with access to local files to inspect the sample:

> Read the sample file returned by this search. Compare the content before and after filtering, check for useful content removed or unhelpful content retained, and explain the findings using Jev's decisions.

The sample contains the original search results, retained content, questions sent to Jev, and Jev's answers. You can compare the actual content at each step. When you finish checking, set `mode` back to `on` and restart to resume everyday use without saving additional complete samples.

## Three-snippet combination filtering

Brave already divides web content into snippets, some as short as a single sentence. Keeping the useful parts of an article while removing unhelpful parts requires individual snippet decisions. A page-level decision can only keep or remove the entire page.

Asking and scoring a separate question for each snippet means that **800 snippets from Brave require 800 questions**. The same filtering instructions must be repeated alongside those questions.

The problem is that **a snippet may be only one sentence, while the instructions for judging it can exceed a hundred tokens.** Many tokens are spent repeating how to judge the content, even when there is little content to judge.

Combining several snippets and assigning one score to the group reduces repeated questions, but that score cannot tell us which snippets to keep and which to remove.

For example, A might describe a database's concurrent write limits, B might contain site navigation, and C might explain deployment steps. Keeping the whole group also keeps the navigation; removing it loses the write limits and deployment steps. We need to express "keep A and C, remove B," which a single score for the group cannot directly represent.

We therefore put **three consecutive snippets from the same source** into one single-choice question, **sharing the question while preserving individual keep-or-remove decisions.**

A, B, and C represent the three snippets. The letters in an option identify the snippets to retain: `A` keeps only A, while `AB` keeps A and B and removes the rest. Three snippets produce eight possible choices:

> A, B, C, AB, AC, BC, ABC (keep all), none (remove all)

In the example above, `AC` means "keep the concurrent write limits and deployment steps, remove the navigation." **One set of filtering instructions in one question can express a separate decision for each of three snippets.** If only two snippets or one remain at the end of a source, the question uses that smaller group.

The filter also considers the probability of each option. For example, `A`, `AB`, `AC`, and `ABC` all mean that A should be retained. We add the probabilities of these four options before deciding whether A is worth keeping. This lets the judgment for a snippet combine evidence from multiple options while still producing an individual keep-or-remove decision.

The content and questions for one search are sent in the same request, with the source text included only once. Sharing one question across three snippets further reduces repetition of filtering instructions. Each snippet can still be handled individually while saving question overhead.

Larger groups introduce their own overhead. Three snippets require eight combinations; four require sixteen. Each additional snippet doubles the number of options. Jev supports up to 255 options per single-choice question, while the full set of combinations for eight snippets already requires 256. We fix each group at three snippets to reduce repeated questions while keeping the number of options manageable.

## Near-threshold compensation

Score-based filtering has another issue: content that leans toward removal can still survive because its score falls just short of the threshold.

For example, if a page is removed only when its filler probability reaches `0.80`, a page scoring `0.78` survives. In inspected samples, some content that offered little practical help fell close to this threshold and was retained by the cutoff alone.

The project applies a narrow compensation band: **judgments within `0.02` of the removal threshold are also considered for removal.** In the example above, `0.78` also triggers removal. This range comes from observations of borderline samples and addresses content that falls just short of meeting the removal condition.

Snippets follow the same principle: low retention probabilities trigger removal, as do probabilities that just reach the retention threshold or exceed it by no more than `0.02`. The model's original probabilities remain unchanged; compensation affects only the final removal decision. Compensation is disabled for any threshold set to `0` or `1`.

## Additional configuration

Use `mode: "on"` for everyday searches, `test` to inspect complete samples, or `off` to disable Jev and retain only basic local cleanup. Restart the MCP server after changing the mode.

To store configuration elsewhere, set `JEV_FILTER_CONFIG_FILE` to the desired file path and create that file yourself. See the [filter configuration guide (Chinese)](https://github.com/romantcig/brave-jev-mcp/blob/release/FILTERING.md) for full configuration, thresholds, and logging details.
