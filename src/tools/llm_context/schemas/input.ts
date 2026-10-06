import { z } from 'zod';

/**
 * Keep up-to-date with documentation:
 * https://api-dashboard.search.brave.com/api-reference/summarizer/llm_context/get
 */

const CountryCodesSchema = z.enum([
  'AR',
  'AU',
  'AT',
  'BE',
  'BR',
  'CA',
  'CL',
  'DK',
  'FI',
  'FR',
  'DE',
  'GR',
  'HK',
  'IN',
  'ID',
  'IT',
  'JP',
  'KR',
  'MY',
  'MX',
  'NL',
  'NZ',
  'NO',
  'CN',
  'PL',
  'PT',
  'PH',
  'RU',
  'SA',
  'ZA',
  'ES',
  'SE',
  'CH',
  'TW',
  'TR',
  'GB',
  'US',
  'ALL',
]);

const SearchLangCodesSchema = z.enum([
  'ar',
  'eu',
  'bn',
  'bg',
  'ca',
  'zh-hans',
  'zh-hant',
  'hr',
  'cs',
  'da',
  'nl',
  'en',
  'en-gb',
  'et',
  'fi',
  'fr',
  'gl',
  'de',
  'el',
  'gu',
  'he',
  'hi',
  'hu',
  'is',
  'it',
  'jp',
  'kn',
  'ko',
  'lv',
  'lt',
  'ms',
  'ml',
  'mr',
  'nb',
  'pl',
  'pt-br',
  'pt-pt',
  'pa',
  'ro',
  'ru',
  'sr',
  'sk',
  'sl',
  'es',
  'sv',
  'ta',
  'te',
  'th',
  'tr',
  'uk',
  'vi',
]);

const FreshnessSchema = z
  .union([
    z.enum(['pd', 'pw', 'pm', 'py']),
    z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2}$/,
        "Use 'pd', 'pw', 'pm', 'py', or a custom range as YYYY-MM-DDtoYYYY-MM-DD."
      ),
  ])
  .describe(
    "Filters search results by when they were discovered. The following values are supported: 'pd' - Discovered within the last 24 hours. 'pw' - Discovered within the last 7 days. 'pm' - Discovered within the last 31 days. 'py' - Discovered within the last 365 days. 'YYYY-MM-DDtoYYYY-MM-DD' - Timeframe is also supported by specifying the date range e.g. 2022-04-01to2022-07-30."
  );

/** 实际请求和工具声明共用默认预算；只在参数省略或为 undefined 时补齐。 */
export const DEFAULT_CONTEXT_PARAMS = Object.freeze({
  count: 10,
  maximum_number_of_urls: 5,
  maximum_number_of_tokens: 4000,
  maximum_number_of_tokens_per_url: 800,
});

export const RequestParamsSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(400)
    .refine((str) => str.split(/\s+/).length <= 50, 'Query cannot exceed 50 words')
    .describe(
      "The user's search query term. Query can not be empty. Maximum of 400 characters and 50 words in the query."
    ),
  country: CountryCodesSchema.describe(
    'The search query country, where the results come from. The country string is limited to 2 character country codes of supported countries.'
  ).optional(),
  search_lang: SearchLangCodesSchema.describe(
    'The search language preference. The 2 or more character language code for which the search results are provided.'
  ).optional(),
  count: z
    .number()
    .int()
    .min(1)
    .max(50)
    .describe(
      `Number of search results considered to select the LLM context data. Defaults to ${DEFAULT_CONTEXT_PARAMS.count}.`
    )
    .default(DEFAULT_CONTEXT_PARAMS.count),
  spellcheck: z.boolean().describe('Whether to enable spellcheck on the query.').optional(),
  maximum_number_of_urls: z
    .number()
    .int()
    .min(1)
    .max(50)
    .describe(
      `Returned source budget. Defaults to ${DEFAULT_CONTEXT_PARAMS.maximum_number_of_urls}.`
    )
    .default(DEFAULT_CONTEXT_PARAMS.maximum_number_of_urls),
  maximum_number_of_tokens: z
    .number()
    .int()
    .min(1024)
    .max(32768)
    .describe(
      `Approximate total token budget. Defaults to ${DEFAULT_CONTEXT_PARAMS.maximum_number_of_tokens}.`
    )
    .default(DEFAULT_CONTEXT_PARAMS.maximum_number_of_tokens),
  maximum_number_of_snippets: z
    .number()
    .int()
    .min(1)
    .max(256)
    .describe(
      'Maximum number of different snippets (or chunks of text) to include in LLM context. The default is 50 and maximum is 256.'
    )
    .optional(),
  context_threshold_mode: z
    .enum(['disabled', 'strict', 'lenient', 'balanced'])
    .describe(
      'The mode to use to determine the threshold for including content in context. Default is balanced.'
    )
    .optional(),
  maximum_number_of_tokens_per_url: z
    .number()
    .int()
    .min(512)
    .max(8192)
    .describe(
      `Token budget per source. Defaults to ${DEFAULT_CONTEXT_PARAMS.maximum_number_of_tokens_per_url}.`
    )
    .default(DEFAULT_CONTEXT_PARAMS.maximum_number_of_tokens_per_url),
  maximum_number_of_snippets_per_url: z
    .number()
    .int()
    .min(1)
    .max(100)
    .describe(
      'Maximum number of snippets to include per URL. The default is 50 and maximum is 100.'
    )
    .optional(),
  goggles: z
    .union([z.string(), z.array(z.string())])
    .describe(
      "Goggles act as a custom re-ranking on top of Brave's search index. The parameter supports both a url where the Goggle is hosted or the definition of the Goggle. Multiple goggle URLs and/or definitions can be provided in an array. For more details, refer to the Goggles repository (i.e., https://github.com/brave/goggles-quickstart)."
    )
    .optional(),
  freshness: FreshnessSchema.optional(),
  enable_local: z
    .boolean()
    .describe(
      'Whether to enable local recall. Not setting this value means auto-detect and uses local recall if any of the localization headers are provided.'
    )
    .optional(),
  enable_source_metadata: z
    .boolean()
    .describe(
      'Enable source metadata enrichment (site_name, favicon) in the sources attribute of the response.'
    )
    .optional(),
});

export const RequestHeadersSchema = z.object({
  'x-loc-lat': z
    .number()
    .min(-90)
    .max(90)
    .describe(
      "The latitude of the client's geographical location in degrees, to provide relevant local results. The latitude must be greater than or equal to -90.0 degrees and less than or equal to +90.0 degrees."
    )
    .optional(),
  'x-loc-long': z
    .number()
    .min(-180)
    .max(180)
    .describe(
      "The longitude of the client's geographical location in degrees, to provide relevant local results. The longitude must be greater than or equal to -180.0 and less than or equal to +180.0 degrees."
    )
    .optional(),
  'x-loc-city': z.string().describe('The generic name of the client city').optional(),
  'x-loc-state': z
    .string()
    .max(3)
    .describe(
      "A code which could be up to three characters, that represent the client's state/region. The region is the first-level subdivision (the broadest or least specific) of the ISO 3166-2 code."
    )
    .optional(),
  'x-loc-state-name': z
    .string()
    .describe(
      'The name of the client’s state/region. The region is the first-level subdivision (the broadest or least specific) of the ISO 3166-2 code.'
    )
    .optional(),
  'x-loc-country': z
    .string()
    .length(2)
    .describe(
      'The two letter country code for the client’s country. For a list of country codes, see ISO 3166-1 alpha-2'
    )
    .optional(),
  'x-loc-postal-code': z.string().describe('The client’s postal code').optional(),
  'api-version': z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe(
      'The API version to use. This is denoted by the format YYYY-MM-DD. Default is the latest that is available. Read more about API versioning at https://api-dashboard.search.brave.com/documentation/guides/versioning.'
    )
    .optional(),
  accept: z
    .enum(['application/json', '*/*'])
    .describe('The default supported media type is application/json.')
    .optional(),
  'cache-control': z
    .literal('no-cache')
    .describe(
      'Brave Search will return cached content by default. To prevent caching set the Cache-Control header to no-cache. This is currently done as best effort.'
    )
    .optional(),
  'user-agent': z
    .string()
    .describe(
      'The user agent originating the request. Brave search can utilize the user agent to provide a different experience depending on the device as described by the string. The user agent should follow the commonly used browser agent strings on each platform. For more information on curating user agents, see RFC 9110.'
    )
    .optional(),
});

// Whitelist of upstream query parameters exposed to the model. `.pick()` keys must
// exist on RequestParamsSchema, so a renamed upstream parameter fails at compile time
// and a newly added one stays hidden until deliberately listed here.
// 四个数值旋钮仅展示默认预算；下限由 applyMinimumValues 统一钳位，上限仍在运行时校验。
// RequestParamsSchema 在执行请求时补齐默认值，保留工具输入原貌供日志与样本记录。
const Picked = RequestParamsSchema.pick({
  query: true,
  country: true,
  search_lang: true,
  freshness: true,
  goggles: true,
});

// Tool declaration: whitelist plus the required `intent`. Header parameters are not
// exposed. `country` / `search_lang` are declared as plain strings so the model is not
// shown the full enum lists; RequestParamsSchema.parse() in execute() still enforces them.
export const LlmContextInputSchema = z.object({
  query: Picked.shape.query.describe(
    'Search keywords; supports site:. At most 400 characters and 50 words.'
  ),
  intent: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe(
      'One English sentence stating what you want to find; name the current version and its defining mechanism when the product is versioned.'
    ),
  country: z
    .string()
    .describe('Two-letter result region code, e.g. "US"; usually omitted.')
    .optional(),
  search_lang: z
    .string()
    .describe('Result language code, e.g. "en" or "zh-hans"; usually omitted.')
    .optional(),
  count: z
    .number()
    .int()
    .max(50)
    // meta 仅调整对外 JSON Schema，不改变上面的整数与上限校验。
    .meta({ minimum: undefined, maximum: undefined, default: DEFAULT_CONTEXT_PARAMS.count })
    .describe(
      `Candidate search results to consider. Omit to use the default of ${DEFAULT_CONTEXT_PARAMS.count}.`
    )
    .optional(),
  maximum_number_of_urls: z
    .number()
    .int()
    .max(50)
    .meta({
      minimum: undefined,
      maximum: undefined,
      default: DEFAULT_CONTEXT_PARAMS.maximum_number_of_urls,
    })
    .describe(
      `Returned source budget. Omit to use the default of ${DEFAULT_CONTEXT_PARAMS.maximum_number_of_urls}.`
    )
    .optional(),
  maximum_number_of_tokens: z
    .number()
    .int()
    .max(32768)
    .meta({
      minimum: undefined,
      maximum: undefined,
      default: DEFAULT_CONTEXT_PARAMS.maximum_number_of_tokens,
    })
    .describe(
      `Approximate total token budget for returned content. Omit to use the default of ${DEFAULT_CONTEXT_PARAMS.maximum_number_of_tokens}.`
    )
    .optional(),
  maximum_number_of_tokens_per_url: z
    .number()
    .int()
    .max(8192)
    .meta({
      minimum: undefined,
      maximum: undefined,
      default: DEFAULT_CONTEXT_PARAMS.maximum_number_of_tokens_per_url,
    })
    .describe(
      `Token budget per source. Omit to use the default of ${DEFAULT_CONTEXT_PARAMS.maximum_number_of_tokens_per_url}.`
    )
    .optional(),
  freshness: Picked.shape.freshness.describe(
    'Recency filter: pd = 1 day, pw = 7 days, pm = 31 days, py = 365 days, or YYYY-MM-DDtoYYYY-MM-DD.'
  ),
  goggles: Picked.shape.goggles
    .describe('Re-ranking rules: a Goggle URL, rule text, or an array of them.')
    .optional(),
});

// Jev 不可用时不暴露 intent；搜索参数及其校验与开启时保持一致。
export const LlmContextUnfilteredInputSchema = LlmContextInputSchema.omit({ intent: true });

export type LlmContextInput = z.input<typeof LlmContextInputSchema>;
export type LlmQueryParams = z.infer<typeof RequestParamsSchema>;
export type LlmRequestHeaders = z.infer<typeof RequestHeadersSchema>;
