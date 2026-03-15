type ModelRefLike = {
  id?: string | null;
  model?: string | null;
  provider?: string | null;
  modelProvider?: string | null;
};

function trimValue(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export function buildCanonicalModelRef(model: string | null | undefined, provider?: string | null) {
  const trimmedModel = trimValue(model);
  if (!trimmedModel) {
    return "";
  }
  const trimmedProvider = trimValue(provider);
  if (!trimmedProvider) {
    return trimmedModel;
  }
  return trimmedModel.toLowerCase().startsWith(`${trimmedProvider.toLowerCase()}/`)
    ? trimmedModel
    : `${trimmedProvider}/${trimmedModel}`;
}

export function buildCanonicalModelRefFromEntry(entry: ModelRefLike): string {
  return buildCanonicalModelRef(entry.model ?? entry.id, entry.modelProvider ?? entry.provider);
}
