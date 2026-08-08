/** Shared budget for parser/LSP and evidence work. */
export const DEFAULT_ANALYSIS_CONCURRENCY = 8;

export const mapWithConcurrency = async <Input, Output>(
  values: readonly Input[],
  mapper: (value: Input, index: number) => Promise<Output>,
  concurrency = DEFAULT_ANALYSIS_CONCURRENCY,
): Promise<Output[]> => {
  if (values.length === 0) return [];
  const results = new Array<Output>(values.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, () => worker()));
  return results;
};
