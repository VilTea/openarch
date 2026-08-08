/** A request budget is evidence capacity, not a path-order priority. */
export const selectByKeyWaves = <Item>(
  items: readonly Item[],
  budget: number,
  keyFor: (item: Item) => string,
): readonly Item[] => {
  if (items.length <= budget) return items;
  const groupsByKey = new Map<string, Item[]>();
  for (const item of items) {
    const key = keyFor(item);
    const group = groupsByKey.get(key);
    if (group) group.push(item);
    else groupsByKey.set(key, [item]);
  }

  const groups = [...groupsByKey.values()];
  const offsets = new Array(groups.length).fill(0);
  const selected: Item[] = [];
  while (selected.length < budget) {
    const available = groups.flatMap((group, index) => offsets[index]! < group.length ? [index] : []);
    if (available.length === 0) break;
    const remaining = budget - selected.length;
    const positions = available.length <= remaining
      ? available.map((_, index) => index)
      : Array.from({ length: remaining }, (_, index) => Math.floor((index + 0.5) * available.length / remaining));
    for (const position of positions) {
      const groupIndex = available[position]!;
      selected.push(groups[groupIndex]![offsets[groupIndex]!]!);
      offsets[groupIndex]! += 1;
    }
  }
  return selected;
};

/** Keep all selected source files, then spend the remaining capacity across the source population. */
export const selectSupportingFiles = (
  files: readonly string[],
  selectedFiles: readonly string[],
  budget: number,
): readonly string[] => {
  if (files.length <= budget) return files;
  const selected = new Set(selectedFiles);
  const remaining = files.filter((file) => !selected.has(file));
  const capacity = budget - selected.size;
  if (capacity <= 0) return [...selected].sort();
  if (remaining.length <= capacity) return [...selected, ...remaining].sort();
  const sampled = Array.from({ length: capacity }, (_, index) =>
    remaining[Math.floor((index + 0.5) * remaining.length / capacity)]!,
  );
  return [...selected, ...sampled].sort();
};
