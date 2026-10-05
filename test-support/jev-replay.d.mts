export function replayFrozen(
  recording: unknown,
  expectedOverride?: Array<{ verdict: 'keep' | 'drop'; kept: boolean[] }>
): {
  sources: number;
  snippets: number;
  input_tokens: number;
  missing_page_dates: number;
};
