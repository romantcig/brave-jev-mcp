# Brave Search MCP · Jev Filter

English | [简体中文](README_CHINESE.md)

Search results can contain pages and snippets that mention the right topic but contribute little to an answer. Passing them all to an AI agent consumes context and leaves the agent to separate useful evidence from noise.

Built on [Brave Search MCP Server](https://github.com/brave/brave-search-mcp-server), this project uses [Jev](https://docs.typesafe.ai/) to filter content before `brave_llm_context` returns it. Filtering follows the search intent, retains useful facts, explanations, and analysis, and preserves Brave's original ordering.

The core design combines **three-snippet choice groups, per-snippet probability recovery, and near-threshold compensation** to reduce repeated question tokens while addressing missed removals and accidental deletions.

## What gets filtered

Matching a topic does not necessarily make a passage useful for a particular question. The filter uses `intent` to judge whether content helps answer the current information need.

- **Page decisions (Noul)** identify pages dominated by generic phrasing, repeated topic names, or articles assembled from headlines. The question protects an author's own evaluation, criticism, comparisons, and arguments when supported by stated reasons.
- **Snippet decisions (Choice)** remove navigation, boilerplate, off-direction content, topic mentions without usable information, and predictions superseded by confirmed events.

Specific facts, technical explanations, architectural comparisons, and practical examples are retention targets. Time-sensitive judgments use retrieval time, available page dates, and the sources from the same search. Explanations and examples that still apply are not treated as useless merely because they are older.

## One question, three independent snippet decisions

Asking a separate question for every snippet repeats the same filtering instructions throughout the request. Combining snippets into a single keep-or-drop decision reduces that repetition but forces useful material and noise to share one outcome.

This project groups **up to three consecutive snippets from the same source** into a Choice question. A, B, and C identify individual snippets, and each option represents a retention combination:

| Option | Meaning          |
| ------ | ---------------- |
| `none` | Remove all three |
| `A`    | Keep only A      |
| `B`    | Keep only B      |
| `AB`   | Keep A and B     |
| `C`    | Keep only C      |
| `AC`   | Keep A and C     |
| `BC`   | Keep B and C     |
| `ABC`  | Keep all three   |

**A single-choice question represents the keep-or-remove state of three snippets.** The snippets share instructions while retaining their individual identities. A group containing both useful material and noise can therefore receive separate outcomes for each snippet. Groups at the end of a source automatically use two snippets or a single snippet when fewer than three remain.

Jev returns a probability distribution over the options. The filter sums the probabilities of all combinations containing a snippet to recover that snippet's retention probability. For example:

```text
P(keep A) = P(A) + P(AB) + P(AC) + P(ABC)
```

Each snippet is then evaluated against its retention threshold. Support for a snippet can accumulate across several combinations, reducing the risk of losing useful content by relying solely on the highest-probability option.

The candidate sources, search intent, and questions for one search are sent in a shared request, with the source text stored once in the shared context. Grouping further reduces the number of questions that must repeat the filtering criteria.

A group of `n` snippets requires `2ⁿ` retention combinations. Larger groups reduce instruction repetition but increase the option count exponentially. Jev's Choice supports up to 255 options; a complete set of eight-snippet combinations would require 256. This project fixes the group size at three, with eight options, balancing instruction cost, option count, and decision granularity.

## Handling decisions near a threshold

A hard threshold gives different outcomes to judgments that are very close together. With a page-removal threshold of `0.80`, for example, a page with a filler probability of `0.78` would survive. Project observations found borderline content that leaned toward removal in this range, allowing unwanted material to slip through the cutoff.

The filter addresses this with a fixed `0.02` compensation band. Valid judgments close enough to the removal boundary also trigger removal. This is an engineering setting adopted from the project's observations of borderline cases, defining how far the compensation extends.

- **Pages use filler probability:** with a removal threshold of `0.80`, a probability of `0.78` also triggers removal.
- **Snippets use retention probability:** values below the retention threshold trigger removal, as do values at the threshold or up to `0.02` above it.

Compensation changes the local decision while preserving the returned probabilities. It is disabled for any threshold set to `0` or `1`. Grouping reduces instruction overhead, per-snippet decisions preserve filtering granularity, and compensation addresses unwanted content near the cutoff.

## Runtime behavior and configuration

Routine calls can omit the search budgets: the server sends `count: 10`, `maximum_number_of_urls: 5`, `maximum_number_of_tokens: 4000`, and `maximum_number_of_tokens_per_url: 800` when omitted. Explicit values override each budget independently. Increase them only when returned results show a need for more source coverage or passage detail.

Local cleanup removes recognizable structured boilerplate, interface remnants, and empty snippets before Jev evaluates the remaining content. Empty sources are removed afterward, preserving the original order of surviving sources and snippets.

If Jev is unavailable, candidates that have passed local cleanup are returned. An invalid group answer cannot justify deleting that group; other valid decisions still apply. The `test` and `on` modes use the same filtering logic, with `test` additionally saving complete samples for inspection.

Set `TYPESAFE_API_KEY` to your Jev API key in the MCP server's `env` configuration. The server reads `~/.brave-jev/config.json` by default and creates it with the following content if it does not exist, preserving existing files:

```json
{ "mode": "on" }
```

The default mode is `on`. Set `mode` to `off` to run basic local cleanup only. Optionally set `JEV_FILTER_CONFIG_FILE` to use a different JSON file; create that file yourself. Restart the MCP server after changing configuration or API keys.

With Jev enabled and a key available, `intent` is required. With `mode: off` or a missing key, the tool exposes search parameters and a description without `intent`. Missing keys also produce configuration instructions in the returned filter status. See the [filter configuration guide (Chinese)](FILTERING.md) for configuration, thresholds, and logs. The filter lives in [src/filter/](src/filter/), with integration in [brave_llm_context](src/tools/llm_context/index.ts).
