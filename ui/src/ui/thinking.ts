import { normalizeLowercaseStringOrEmpty } from "./string-coerce.ts";

export type ThinkingCatalogEntry = {
  provider: string;
  id: string;
  reasoning?: boolean;
};

const BASE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
const BINARY_THINKING_LEVELS = ["off", "on"] as const;
const ANTHROPIC_CLAUDE_46_MODEL_RE = /^claude-(?:opus|sonnet)-4(?:\.|-)6(?:$|[-.])/i;
const ANTHROPIC_OPUS_47_MODEL_RE = /^claude-opus-4(?:\.|-)7(?:$|[-.])/i;
const AMAZON_BEDROCK_CLAUDE_46_MODEL_RE = /claude-(?:opus|sonnet)-4(?:\.|-)6(?:$|[-.])/i;
const OPENAI_XHIGH_MODEL_RE =
  /^(?:gpt-5\.[2-9](?:\.\d+)?|gpt-5\.[2-9](?:\.\d+)?-pro|gpt-5\.\d+-codex|gpt-5\.\d+-codex-spark|gpt-5\.1-codex|gpt-5\.2-codex)(?:$|-)/i;

export function normalizeThinkingProviderId(provider?: string | null): string {
  if (!provider) {
    return "";
  }
  const normalized = normalizeLowercaseStringOrEmpty(provider);
  if (normalized === "z.ai" || normalized === "z-ai") {
    return "zai";
  }
  if (normalized === "bedrock" || normalized === "aws-bedrock") {
    return "amazon-bedrock";
  }
  return normalized;
}

export function isBinaryThinkingProvider(provider?: string | null): boolean {
  return normalizeThinkingProviderId(provider) === "zai";
}

export function normalizeThinkLevel(raw?: string | null): string | undefined {
  if (!raw) {
    return undefined;
  }
  const key = normalizeLowercaseStringOrEmpty(raw);
  const collapsed = key.replace(/[\s_-]+/g, "");
  if (collapsed === "adaptive" || collapsed === "auto") {
    return "adaptive";
  }
  if (collapsed === "max") {
    return "max";
  }
  if (collapsed === "xhigh" || collapsed === "extrahigh") {
    return "xhigh";
  }
  if (key === "off") {
    return "off";
  }
  if (["on", "enable", "enabled"].includes(key)) {
    return "low";
  }
  if (["min", "minimal"].includes(key)) {
    return "minimal";
  }
  if (["low", "thinkhard", "think-hard", "think_hard"].includes(key)) {
    return "low";
  }
  if (["mid", "med", "medium", "thinkharder", "think-harder", "harder"].includes(key)) {
    return "medium";
  }
  if (["high", "ultra", "ultrathink", "think-hard", "thinkhardest", "highest"].includes(key)) {
    return "high";
  }
  if (key === "think") {
    return "minimal";
  }
  return undefined;
}

function supportsAdaptiveThinking(provider?: string | null, model?: string | null): boolean {
  const normalizedProvider = normalizeThinkingProviderId(provider);
  const modelId = model?.trim() ?? "";
  if (normalizedProvider === "anthropic") {
    return ANTHROPIC_CLAUDE_46_MODEL_RE.test(modelId) || ANTHROPIC_OPUS_47_MODEL_RE.test(modelId);
  }
  if (normalizedProvider === "amazon-bedrock") {
    return AMAZON_BEDROCK_CLAUDE_46_MODEL_RE.test(modelId);
  }
  return false;
}

function supportsXHighThinking(provider?: string | null, model?: string | null): boolean {
  const normalizedProvider = normalizeThinkingProviderId(provider);
  const modelId = model?.trim() ?? "";
  if (normalizedProvider === "anthropic") {
    return ANTHROPIC_OPUS_47_MODEL_RE.test(modelId);
  }
  if (["openai", "openai-codex", "github-copilot", "codex"].includes(normalizedProvider)) {
    return OPENAI_XHIGH_MODEL_RE.test(modelId);
  }
  return false;
}

function supportsMaxThinking(provider?: string | null, model?: string | null): boolean {
  return normalizeThinkingProviderId(provider) === "anthropic"
    ? ANTHROPIC_OPUS_47_MODEL_RE.test(model?.trim() ?? "")
    : false;
}

export function listThinkingLevelLabels(
  provider?: string | null,
  model?: string | null,
): readonly string[] {
  if (isBinaryThinkingProvider(provider)) {
    return BINARY_THINKING_LEVELS;
  }
  return [
    ...BASE_THINKING_LEVELS,
    ...(supportsXHighThinking(provider, model) ? ["xhigh"] : []),
    ...(supportsAdaptiveThinking(provider, model) ? ["adaptive"] : []),
    ...(supportsMaxThinking(provider, model) ? ["max"] : []),
  ];
}

export function formatThinkingLevels(provider?: string | null, model?: string | null): string {
  return listThinkingLevelLabels(provider, model).join(", ");
}

export function resolveThinkingDefaultForModel(params: {
  provider: string;
  model: string;
  catalog?: ThinkingCatalogEntry[];
}): string {
  const normalizedProvider = normalizeThinkingProviderId(params.provider);
  const modelId = params.model.trim();
  if (normalizedProvider === "anthropic" && ANTHROPIC_CLAUDE_46_MODEL_RE.test(modelId)) {
    return "adaptive";
  }
  if (normalizedProvider === "amazon-bedrock" && AMAZON_BEDROCK_CLAUDE_46_MODEL_RE.test(modelId)) {
    return "adaptive";
  }
  const candidate = params.catalog?.find(
    (entry) => entry.provider === params.provider && entry.id === params.model,
  );
  return candidate?.reasoning ? "low" : "off";
}
