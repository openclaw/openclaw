import { bundledPluginRoot } from "./scripts/lib/bundled-plugin-paths.mjs";

export const providerExtensionIds = [
  "amazon-bedrock",
  "anthropic",
  "anthropic-vertex",
  "byteplus",
  "chutes",
  "deepseek",
  "github-copilot",
  "google",
  "groq",
  "huggingface",
  "kimi-coding",
  "microsoft",
  "microsoft-foundry",
  "minimax",
  "mistral",
  "qwen",
  "moonshot",
  "nvidia",
  "ollama",
  "openai",
  "openrouter",
  "qianfan",
  "stepfun",
  "together",
  "venice",
  "volcengine",
  "xai",
  "zai",
];

export const providerExtensionTestRoots = providerExtensionIds.map((id) => bundledPluginRoot(id));

export function isProviderExtensionRoot(root) {
  return providerExtensionTestRoots.includes(root);
}
