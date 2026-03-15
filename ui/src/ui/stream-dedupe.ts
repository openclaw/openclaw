export type TextStreamSegment = { text: string };

export function appendUniqueText(base: string, suffix: string): string {
  if (!suffix) {
    return base;
  }
  if (!base) {
    return suffix;
  }
  if (base.endsWith(suffix)) {
    return base;
  }
  const maxOverlap = Math.min(base.length, suffix.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (base.slice(-overlap) === suffix.slice(0, overlap)) {
      return base + suffix.slice(overlap);
    }
  }
  return base + suffix;
}

export function getCommittedText<T extends TextStreamSegment>(segments: readonly T[]): string {
  // Segments are incremental (non-cumulative), so plain concatenation is correct here.
  // appendUniqueText would incorrectly collapse two identical consecutive segments into one.
  return segments.map((s) => s.text).join("");
}

export function getIncrementalTextAgainstCommitted(committed: string, text: string): string {
  if (!committed) {
    return text;
  }
  if (!text || text === committed) {
    return "";
  }
  if (text.startsWith(committed)) {
    return text.slice(committed.length);
  }
  if (committed.endsWith(text)) {
    return "";
  }
  const maxOverlap = Math.min(committed.length, text.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (committed.slice(-overlap) === text.slice(0, overlap)) {
      return text.slice(overlap);
    }
  }
  return text;
}

export function getIncrementalStreamText<T extends TextStreamSegment>(
  segments: readonly T[],
  text: string,
): string {
  return getIncrementalTextAgainstCommitted(getCommittedText(segments), text);
}

export function getLiveStreamPreviewText<T extends TextStreamSegment>(
  segments: readonly T[],
  stream: string | null,
): string | null {
  if (stream == null) {
    return null;
  }
  return getIncrementalTextAgainstCommitted(getCommittedText(segments), stream);
}
