type ToSortedFn = <T>(this: T[], compareFn?: (a: T, b: T) => number) => T[];

function defaultCompare(a: unknown, b: unknown): number {
  const left = String(a);
  const right = String(b);
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function toSortedCopy<T>(values: T[], compareFn?: (a: T, b: T) => number): T[] {
  const sorted = [...values];
  const compare =
    compareFn ??
    ((left: T, right: T) => {
      return defaultCompare(left, right);
    });
  for (let i = 1; i < sorted.length; i += 1) {
    const value = sorted[i];
    let j = i - 1;
    while (j >= 0 && compare(sorted[j], value) > 0) {
      sorted[j + 1] = sorted[j];
      j -= 1;
    }
    sorted[j + 1] = value;
  }
  return sorted;
}

export function installUiPolyfills(): void {
  const arrayPrototype = Array.prototype as Array<unknown> & {
    toSorted?: ToSortedFn;
  };
  if (typeof arrayPrototype.toSorted === "function") {
    return;
  }
  Object.defineProperty(arrayPrototype, "toSorted", {
    value: function toSorted<T>(this: T[], compareFn?: (a: T, b: T) => number): T[] {
      return toSortedCopy(this, compareFn);
    },
    writable: true,
    configurable: true,
  });
}

installUiPolyfills();
