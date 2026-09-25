import type { TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import API from '../../BraveAPI/index.js';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  RequestParamsSchema,
  RequestHeadersSchema,
  LlmContextInputSchema,
  type LlmContextInput as QueryParams,
} from './schemas/input.js';
import { LlmContextSearchApiResponseSchema } from './schemas/output.js';
import {
  applyMinimumValues,
  applyOverfetch,
  createJevClassifier,
  filterLlmContext,
  hasJevKey,
  logRaisedToStderr,
  parseFilterConfig,
  resolveToolDescription,
  withAdjustments,
} from '../../filter/index.js';
import type { ClassifyDeps, FilterConfig, FilterDeps } from '../../filter/index.js';

export const name = 'brave_llm_context';

export const annotations: ToolAnnotations = {
  title: 'Brave LLM Context',
  openWorldHint: true,
};

export const description = `
    Search the web with Brave and return pre-extracted, relevance-ranked content chunks
    (prose, tables, code blocks, structured data). Use the returned content directly when
    it answers the question; fetch the page only when you need the full context or must verify.

    Required: \`intent\` — one English sentence stating what you want to find. If the query
    concerns a versioned product, name the current version and its defining mechanism in
    \`intent\` (e.g. "current Sanity Studio (v6, sanity.config.ts based)").

    Recommended values for routine calls (\`query\` supports site:):
        count: 10
        maximum_number_of_urls: 5
        maximum_number_of_tokens: 4000
        maximum_number_of_tokens_per_url: 800 (= 4000 / 5; without it one source can take the whole budget)

    Search rules:
        - Unfamiliar subject: first search the subject name plus the core question for an overview,
          then verify details as needed; do not search for a given detail directly — check whether
          it surfaces naturally in the sources.
        - Keep only keywords directly relevant to the current question in \`query\`; do not pack
          context and qualifiers into one query.
        - Set \`freshness\` (pd / pw / pm / py) when recency matters; never hardcode a year in \`query\`.
        - Two consecutive searches with heavily overlapping results mean the direction is exhausted:
          change the keyword strategy.
        - Search serially; go parallel only when confident of each query.

    When relaying results, cite the source URLs from the "sources" map.
`.trim();

// 进程级 Jev 分类器惰性单例（A13）：熔断计数与并发闸住 createJevClassifier 闭包，
// 跨请求复用——库自身无模块级可变状态（stats.ts 不变式）。mode 为 off 时不创建、
// 不读 key；mode 非 off 且 key 缺失时按等价 off 处理（EMBED-05：stderr 一行、
// 不传 deps，管道记 no_key 零请求），实例只在 key 可用时创建。
let jevClassifier: ClassifyDeps | undefined;

const jevDepsFor = (config: FilterConfig): FilterDeps | undefined => {
  if (config.mode === 'off') return undefined;
  if (!hasJevKey(process.env)) {
    console.error(
      '[jev-filter] No Jev API key found (jev_API_KEY / TYPESAFE_API_KEY); treating Jev filtering as off.'
    );
    return undefined;
  }
  jevClassifier ??= createJevClassifier(config.jev, process.env);
  return { classify: jevClassifier.classify };
};

export const execute = async (params: QueryParams) => {
  const { adjusted, raised } = applyMinimumValues(params);
  const parsedParams = RequestParamsSchema.parse(adjusted);
  const parsedHeaders = RequestHeadersSchema.parse(params);
  const filterConfig = parseFilterConfig(process.env);
  const braveParams = applyOverfetch(parsedParams, filterConfig);

  const response = await API.issueRequest<'llmContext'>('llmContext', braveParams, parsedHeaders);
  const { success, data, error } = LlmContextSearchApiResponseSchema.safeParse(response);
  const payload = success
    ? withAdjustments(
        (
          await filterLlmContext(
            data,
            { params: parsedParams, intent: params.intent },
            filterConfig,
            jevDepsFor(filterConfig)
          )
        ).result,
        raised
      )
    : z.treeifyError(error);

  logRaisedToStderr(raised);

  return {
    content: [{ type: 'text', text: JSON.stringify(payload) } as TextContent],
    isError: !success,
  };
};

export const register = (mcpServer: McpServer) => {
  mcpServer.registerTool(
    name,
    {
      title: name,
      description: resolveToolDescription(description),
      inputSchema: LlmContextInputSchema,
      annotations: annotations,
    },
    execute
  );
};

export default {
  name,
  description,
  annotations,
  inputSchema: LlmContextInputSchema.shape,
  execute,
  register,
};
