type SortCompareFn<T> = (a: T, b: T) => number;

type MaybeToSortedArray<T> = readonly T[] & {
  toSorted?: (compareFn: SortCompareFn<T>) => T[];
};

export function toSortedCompat<T>(values: readonly T[], compareFn: SortCompareFn<T>): T[] {
  const copy = [...values];
  const maybeToSorted = (values as MaybeToSortedArray<T>).toSorted;
  if (typeof maybeToSorted === "function") {
    return maybeToSorted.call(copy, compareFn);
  }
  return stableInsertionSort(copy, compareFn);
}

function stableInsertionSort<T>(values: T[], compareFn: SortCompareFn<T>): T[] {
  for (let i = 1; i < values.length; i += 1) {
    const current = values[i];
    let cursor = i - 1;
    while (cursor >= 0 && compareFn(values[cursor], current) > 0) {
      values[cursor + 1] = values[cursor];
      cursor -= 1;
    }
    values[cursor + 1] = current;
  }
  return values;
}
