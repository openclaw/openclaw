type CompareFn<T> = (a: T, b: T) => number;

type ArrayWithToSorted<T> = readonly T[] & {
  toSorted?: (compareFn?: CompareFn<T>) => T[];
};

export function toSortedCompat<T>(items: readonly T[], compareFn?: CompareFn<T>): T[] {
  const native = (items as ArrayWithToSorted<T>).toSorted;
  if (typeof native === "function") {
    return native.call(items, compareFn);
  }
  const copy = [...items];
  copy.sort(compareFn);
  return copy;
}
