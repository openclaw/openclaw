function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

export function getTagFilters(query: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  const pattern = /(^|\s)tag:([^\s]+)/gi;
  const raw = query.trim();
  let match: RegExpExecArray | null = pattern.exec(raw);
  while (match) {
    const normalized = normalizeTag(match[2] ?? "");
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      tags.push(normalized);
    }
    match = pattern.exec(raw);
  }
  return tags;
}

export function hasTagFilter(query: string, tag: string): boolean {
  const normalizedTag = normalizeTag(tag);
  if (!normalizedTag) {
    return false;
  }
  const pattern = new RegExp(`(^|\\s)tag:${escapeRegExp(normalizedTag)}(?=\\s|$)`, "i");
  return pattern.test(query.trim());
}

export function appendTagFilter(query: string, tag: string): string {
  const normalizedTag = normalizeTag(tag);
  const trimmed = query.trim();
  if (!normalizedTag) {
    return trimmed;
  }
  if (!trimmed) {
    return `tag:${normalizedTag}`;
  }
  if (hasTagFilter(trimmed, normalizedTag)) {
    return trimmed;
  }
  return `${trimmed} tag:${normalizedTag}`;
}

export function removeTagFilter(query: string, tag: string): string {
  const normalizedTag = normalizeTag(tag);
  const trimmed = query.trim();
  if (!normalizedTag || !trimmed) {
    return trimmed;
  }
  const pattern = new RegExp(`(^|\\s)tag:${escapeRegExp(normalizedTag)}(?=\\s|$)`, "ig");
  return trimmed.replace(pattern, " ").replace(/\s+/g, " ").trim();
}

export function replaceTagFilters(query: string, tags: readonly string[]): string {
  const uniqueTags: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    uniqueTags.push(normalized);
  }

  const trimmed = query.trim();
  const withoutTags = trimmed
    .replace(/(^|\s)tag:([^\s]+)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tagTokens = uniqueTags.map((tag) => `tag:${tag}`).join(" ");
  if (withoutTags && tagTokens) {
    return `${withoutTags} ${tagTokens}`;
  }
  if (withoutTags) {
    return withoutTags;
  }
  return tagTokens;
}

export function toggleTagFilter(query: string, tag: string): string {
  if (hasTagFilter(query, tag)) {
    return removeTagFilter(query, tag);
  }
  return appendTagFilter(query, tag);
}
