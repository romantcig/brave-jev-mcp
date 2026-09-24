import type { TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import API from '../../BraveAPI/index.js';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  RequestParamsSchema,
  RequestHeadersSchema,
  LlmContextInputSchema,
  applyMinimumValues,
  type LlmContextInput as QueryParams,
  type RaisedParameter,
} from './schemas/input.js';
import { LlmContextSearchApiResponseSchema } from './schemas/output.js';
import {
  applyOverfetch,
  filterLlmContext,
  parseFilterConfig,
  resolveToolDescription,
  type FilteredResponse,
} from '../../filter/index.js';

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

/** 载荷与 Brave 响应同形；只有发生下限钳位时才附加 parameter_adjustments 键。 */
type WithAdjustments = FilteredResponse & {
  parameter_adjustments?: Record<string, { requested: number; applied: number }>;
};

/** 写时复制附加钳位清单，不改动过滤层返回的对象；未触发时原引用返回。 */
const withAdjustments = (payload: FilteredResponse, raised: RaisedParameter[]): WithAdjustments => {
  if (raised.length === 0) return payload;
  return {
    ...payload,
    parameter_adjustments: Object.fromEntries(
      raised.map(({ parameter, requested, applied }) => [parameter, { requested, applied }])
    ),
  };
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
        filterLlmContext(data, { params: parsedParams, intent: params.intent }, filterConfig)
          .result,
        raised
      )
    : z.treeifyError(error);

  // stderr 是诊断通道，不进协议；只在钳位真正发生时输出一行
  if (raised.length > 0) {
    console.error(
      `[brave_llm_context] raised below-minimum parameters: ${raised
        .map((r) => `${r.parameter} ${r.requested} -> ${r.applied}`)
        .join(', ')}`
    );
  }

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
