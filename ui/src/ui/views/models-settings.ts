import { html, nothing, type TemplateResult } from "lit";
import type { ConfigUiHints } from "../types.ts";

/**
 * Models Settings View
 *
 * A specialized, card-based interface for configuring AI model providers.
 * Replaces the generic form renderer for the "models" section with a more
 * intuitive, visual approach that:
 *
 * - Shows provider cards with status indicators
 * - Auto-detects credentials from environment variables
 * - Displays models in a compact, scannable grid
 * - Reduces scrolling through tabbed/collapsible sections
 */

// Provider metadata for display
export type ProviderMeta = {
  id: string;
  name: string;
  description: string;
  icon: TemplateResult;
  color: string; // CSS color for accent
  envVars: string[]; // Environment variables to check
  docsUrl?: string;
};

// Provider status
export type ProviderStatus = "configured" | "detected" | "available" | "unavailable";

// Model display info
export type ModelInfo = {
  id: string;
  name: string;
  reasoning: boolean;
  vision: boolean;
  contextWindow: number;
  maxTokens: number;
};

/** Model from gateway catalog (models.list RPC) */
export type GatewayCatalogModel = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
};

// Props for the models settings component
export type ModelsSettingsProps = {
  value: ModelsConfigValue | null;
  disabled?: boolean;
  hints: ConfigUiHints;
  detectedProviders: Record<string, DetectedProvider>;
  /** Models from gateway catalog (models.list RPC) - the source of truth for available models */
  gatewayCatalog: GatewayCatalogModel[];
  /** Whether the catalog is currently loading */
  catalogLoading?: boolean;
  onPatch: (path: Array<string | number>, value: unknown) => void;
  onRefreshModels?: () => void;
  /** Trigger OAuth/auth flow for a provider */
  onAuthProvider?: (providerId: string, authType: string) => void;
};

export type DetectedProvider = {
  envVar: string;
  hasKey: boolean;
  source: "env" | "profile" | "config";
};

export type ModelsConfigValue = {
  mode?: "merge" | "replace";
  providers?: Record<string, ProviderConfigValue>;
  bedrockDiscovery?: {
    enabled?: boolean;
    region?: string;
  };
  /** Model IDs that are disabled (format: "provider/model-id") */
  disabledModels?: string[];
};

export type ProviderConfigValue = {
  baseUrl?: string;
  apiKey?: string;
  auth?: "api-key" | "aws-sdk" | "oauth" | "token";
  api?:
    | "openai-completions"
    | "openai-responses"
    | "anthropic-messages"
    | "google-generative-ai"
    | "github-copilot"
    | "bedrock-converse-stream";
  headers?: Record<string, string>;
  authHeader?: boolean;
  models?: ModelConfigValue[];
};

export type ModelConfigValue = {
  id: string;
  name: string;
  reasoning?: boolean;
  input?: string[];
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
};

// API options for dropdown
const API_OPTIONS = [
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "openai-completions", label: "OpenAI Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "google-generative-ai", label: "Google Generative AI" },
  { value: "github-copilot", label: "GitHub Copilot" },
  { value: "bedrock-converse-stream", label: "Bedrock Converse" },
] as const;

// Auth mode options for dropdown
const AUTH_OPTIONS = [
  { value: "api-key", label: "API Key" },
  { value: "token", label: "Token (Claude CLI)" },
  { value: "oauth", label: "OAuth" },
  { value: "aws-sdk", label: "AWS SDK" },
] as const;

// Default API for known providers
function getDefaultApi(providerId: string): string {
  const defaults: Record<string, string> = {
    anthropic: "anthropic-messages",
    openai: "openai-responses",
    google: "google-generative-ai",
    groq: "openai-completions",
    xai: "openai-completions",
    openrouter: "openai-completions",
    mistral: "openai-completions",
    ollama: "openai-completions",
    "amazon-bedrock": "bedrock-converse-stream",
    "github-copilot": "github-copilot",
  };
  return defaults[providerId] ?? "openai-completions";
}

// Known providers with their metadata
const KNOWN_PROVIDERS: ProviderMeta[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude models - Opus, Sonnet, Haiku",
    icon: html`
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path
          d="M17.304 3.541l-5.29 13.082-2.058-5.088L4.667 3.54H2l7.672 16.918h2.349L19.695 3.541h-2.391zM12.059 6.672l2.058 5.088 5.216 8.699h2.666l-7.581-12.67-2.359-1.117z"
        />
      </svg>
    `,
    color: "#D97757",
    envVars: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
    docsUrl: "https://docs.openclaw.ai/providers/anthropic",
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "GPT-5, GPT-5-mini, o-series reasoning",
    icon: html`
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path
          d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.8956zm16.5963 3.8558L13.1038 8.364l2.0201-1.1638a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.4046-.6813zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.6696zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
        />
      </svg>
    `,
    color: "#10A37F",
    envVars: ["OPENAI_API_KEY"],
    docsUrl: "https://docs.openclaw.ai/providers/openai",
  },
  {
    id: "google",
    name: "Google",
    description: "Gemini 3 Pro, Flash, and more",
    icon: html`
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path
          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        />
        <path
          d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        />
        <path
          d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        />
        <path
          d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        />
      </svg>
    `,
    color: "#4285F4",
    envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    docsUrl: "https://docs.openclaw.ai/providers/google",
  },
  {
    id: "groq",
    name: "Groq",
    description: "Ultra-fast inference for Llama, Mixtral",
    icon: html`
      <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10" /></svg>
    `,
    color: "#F55036",
    envVars: ["GROQ_API_KEY"],
    docsUrl: "https://docs.openclaw.ai/providers/groq",
  },
  {
    id: "xai",
    name: "xAI",
    description: "Grok models",
    icon: html`
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path
          d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
        />
      </svg>
    `,
    color: "#000000",
    envVars: ["XAI_API_KEY"],
    docsUrl: "https://docs.openclaw.ai/providers/xai",
  },
  {
    id: "amazon-bedrock",
    name: "AWS Bedrock",
    description: "Claude, Llama, Titan via AWS",
    icon: html`
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path
          d="M12 2L2 7v10l10 5 10-5V7L12 2zm0 2.5L18.5 7 12 9.5 5.5 7 12 4.5zM4 8.5l7 3.5v7l-7-3.5v-7zm16 0v7l-7 3.5v-7l7-3.5z"
        />
      </svg>
    `,
    color: "#FF9900",
    envVars: ["AWS_ACCESS_KEY_ID", "AWS_PROFILE"],
    docsUrl: "https://docs.openclaw.ai/providers/bedrock",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "Gateway to 100+ models",
    icon: html`
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path
          d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"
        />
      </svg>
    `,
    color: "#6366F1",
    envVars: ["OPENROUTER_API_KEY"],
    docsUrl: "https://docs.openclaw.ai/providers/openrouter",
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    description: "Use Copilot subscription for agents",
    icon: html`
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path
          d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"
        />
      </svg>
    `,
    color: "#24292F",
    envVars: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
    docsUrl: "https://docs.openclaw.ai/providers/github-copilot",
  },
  {
    id: "ollama",
    name: "Ollama",
    description: "Local models on your machine",
    icon: html`
      <svg viewBox="0 0 24 24" fill="currentColor">
        <circle cx="12" cy="12" r="10" />
        <circle cx="12" cy="12" r="4" fill="var(--bg-elevated)" />
      </svg>
    `,
    color: "#1A1A1A",
    envVars: [],
    docsUrl: "https://docs.openclaw.ai/providers/ollama",
  },
  {
    id: "mistral",
    name: "Mistral",
    description: "Mistral Large, Medium, Small",
    icon: html`
      <svg viewBox="0 0 24 24" fill="currentColor">
        <rect x="2" y="2" width="8" height="8" />
        <rect x="14" y="2" width="8" height="8" />
        <rect x="2" y="14" width="8" height="8" />
        <rect x="14" y="14" width="8" height="8" />
      </svg>
    `,
    color: "#FF7000",
    envVars: ["MISTRAL_API_KEY"],
    docsUrl: "https://docs.openclaw.ai/providers/mistral",
  },
];

function getProviderStatus(
  meta: ProviderMeta,
  configured: boolean,
  detected: DetectedProvider | undefined,
): ProviderStatus {
  if (configured) {
    return "configured";
  }
  if (detected?.hasKey) {
    return "detected";
  }
  return "available";
}

function getStatusLabel(status: ProviderStatus): string {
  switch (status) {
    case "configured":
      return "Configured";
    case "detected":
      return "Ready";
    case "available":
      return "Not configured";
    case "unavailable":
      return "Unavailable";
  }
}

function formatNumber(n: number): string {
  if (n >= 1000000) {
    return `${(n / 1000000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(0)}K`;
  }
  return String(n);
}

/** Group gateway catalog models by provider */
function groupCatalogByProvider(
  catalog: GatewayCatalogModel[],
): Map<string, GatewayCatalogModel[]> {
  const byProvider = new Map<string, GatewayCatalogModel[]>();
  for (const model of catalog) {
    const provider = model.provider || "other";
    const existing = byProvider.get(provider) || [];
    existing.push(model);
    byProvider.set(provider, existing);
  }
  return byProvider;
}

/** Provider-specific auth options */
const PROVIDER_AUTH_OPTIONS: Record<
  string,
  Array<{ type: string; label: string; description: string }>
> = {
  anthropic: [
    {
      type: "api-key",
      label: "API Key",
      description: "Use ANTHROPIC_API_KEY environment variable",
    },
    { type: "token", label: "Setup Token", description: "Claude subscription via setup-token" },
  ],
  openai: [
    { type: "api-key", label: "API Key", description: "Use OPENAI_API_KEY environment variable" },
    { type: "oauth", label: "Codex OAuth", description: "ChatGPT/Codex subscription" },
  ],
  google: [
    { type: "api-key", label: "API Key", description: "Use GEMINI_API_KEY environment variable" },
    { type: "oauth", label: "Gemini CLI OAuth", description: "OAuth via Google CLI plugin" },
  ],
  "github-copilot": [{ type: "oauth", label: "GitHub OAuth", description: "Sign in with GitHub" }],
  "amazon-bedrock": [
    { type: "aws-sdk", label: "AWS SDK", description: "Use AWS credentials (profile or env vars)" },
  ],
  openrouter: [
    {
      type: "api-key",
      label: "API Key",
      description: "Use OPENROUTER_API_KEY environment variable",
    },
  ],
  groq: [
    { type: "api-key", label: "API Key", description: "Use GROQ_API_KEY environment variable" },
  ],
  xai: [{ type: "api-key", label: "API Key", description: "Use XAI_API_KEY environment variable" }],
  mistral: [
    { type: "api-key", label: "API Key", description: "Use MISTRAL_API_KEY environment variable" },
  ],
  ollama: [
    {
      type: "api-key",
      label: "Local (No Auth)",
      description: "Ollama runs locally without authentication",
    },
  ],
  "qwen-portal": [{ type: "oauth", label: "Qwen OAuth", description: "Free-tier OAuth flow" }],
  minimax: [
    { type: "api-key", label: "API Key", description: "Use MINIMAX_API_KEY environment variable" },
    { type: "oauth", label: "MiniMax OAuth", description: "OAuth via MiniMax portal plugin" },
  ],
  moonshot: [
    { type: "api-key", label: "API Key", description: "Use MOONSHOT_API_KEY environment variable" },
  ],
  venice: [
    { type: "api-key", label: "API Key", description: "Use VENICE_API_KEY environment variable" },
  ],
  deepgram: [
    { type: "api-key", label: "API Key", description: "Use DEEPGRAM_API_KEY environment variable" },
  ],
};

// Icons
const icons = {
  check: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
      <polyline points="20 6 9 17 4 12"></polyline>
    </svg>
  `,
  plus: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <line x1="12" y1="5" x2="12" y2="19"></line>
      <line x1="5" y1="12" x2="19" y2="12"></line>
    </svg>
  `,
  refresh: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M23 4v6h-6"></path>
      <path d="M1 20v-6h6"></path>
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
    </svg>
  `,
  chevronDown: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="6 9 12 15 18 9"></polyline>
    </svg>
  `,
  externalLink: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
      <polyline points="15 3 21 3 21 9"></polyline>
      <line x1="10" y1="14" x2="21" y2="3"></line>
    </svg>
  `,
  brain: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <path
        d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"
      ></path>
      <path
        d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"
      ></path>
      <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"></path>
      <path d="M12 18v4"></path>
    </svg>
  `,
  eye: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
  `,
  zap: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
    </svg>
  `,
  info: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="12" y1="16" x2="12" y2="12"></line>
      <line x1="12" y1="8" x2="12.01" y2="8"></line>
    </svg>
  `,
  settings: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="3"></circle>
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
      ></path>
    </svg>
  `,
};

function renderProviderCard(
  meta: ProviderMeta,
  config: ProviderConfigValue | undefined,
  detected: DetectedProvider | undefined,
  props: ModelsSettingsProps,
  catalogModels: GatewayCatalogModel[],
  _expanded: boolean,
  _onToggle: () => void,
): TemplateResult {
  const isConfigured = Boolean(config);
  const status = getProviderStatus(meta, isConfigured, detected);
  // Use catalog models from gateway, not config models
  const modelCount = catalogModels.length;
  const authOptions = PROVIDER_AUTH_OPTIONS[meta.id] ?? [];

  const statusClass =
    status === "configured"
      ? "models-provider-card--configured"
      : status === "detected"
        ? "models-provider-card--detected"
        : "";

  return html`
    <div class="models-provider-card ${statusClass}" style="--provider-color: ${meta.color}">
      <div class="models-provider-card__header">
        <div class="models-provider-card__icon">${meta.icon}</div>
        <div class="models-provider-card__info">
          <div class="models-provider-card__name">${meta.name}</div>
          <div class="models-provider-card__desc">${meta.description}</div>
        </div>
        <div class="models-provider-card__status">
          ${
            status === "configured" || status === "detected"
              ? html`<span class="models-status-badge models-status-badge--${status}">${icons.check} ${getStatusLabel(status)}</span>`
              : html`<span class="models-status-badge models-status-badge--available">${getStatusLabel(status)}</span>`
          }
          ${modelCount > 0 ? html`<span class="models-provider-card__count">${modelCount} model${modelCount !== 1 ? "s" : ""}</span>` : nothing}
        </div>
      </div>

      <div class="models-provider-card__body">
              ${
                status === "detected" && !isConfigured
                  ? html`
                    <div class="models-provider-card__detected-banner">
                      <div class="models-detected-info">
                        ${icons.zap}
                        <span>API key detected from <code>${detected?.envVar}</code></span>
                      </div>
                      <button
                        class="btn btn--sm primary"
                        @click=${() => {
                          // Enable this provider with auto-detected key
                          props.onPatch(["providers", meta.id], {
                            baseUrl: getDefaultBaseUrl(meta.id),
                            apiKey: `\${${detected?.envVar}}`,
                            models: [],
                          });
                        }}
                      >
                        Enable Provider
                      </button>
                    </div>
                  `
                  : nothing
              }

              ${
                isConfigured
                  ? html`
                    <div class="models-provider-card__config">
                      <div class="models-config-grid">
                        <div class="models-config-row">
                          <label class="models-config-label">Base URL</label>
                          <input
                            type="text"
                            class="models-config-input"
                            .value=${config?.baseUrl ?? ""}
                            ?disabled=${props.disabled}
                            @input=${(e: Event) => props.onPatch(["providers", meta.id, "baseUrl"], (e.target as HTMLInputElement).value)}
                            placeholder="https://api.example.com"
                          />
                        </div>
                        <div class="models-config-row">
                          <label class="models-config-label">API Key</label>
                          <input
                            type="password"
                            class="models-config-input"
                            .value=${config?.apiKey ?? ""}
                            ?disabled=${props.disabled}
                            @input=${(e: Event) => props.onPatch(["providers", meta.id, "apiKey"], (e.target as HTMLInputElement).value)}
                            placeholder="sk-... or \${${meta.envVars[0] ?? "API_KEY"}}"
                          />
                          ${
                            detected?.hasKey
                              ? html`<span class="models-env-hint">Detected: ${detected.envVar}</span>`
                              : nothing
                          }
                        </div>
                        <div class="models-config-row">
                          <label class="models-config-label">Auth Mode</label>
                          <select
                            class="models-config-select"
                            .value=${config?.auth ?? "api-key"}
                            ?disabled=${props.disabled}
                            @change=${(e: Event) => props.onPatch(["providers", meta.id, "auth"], (e.target as HTMLSelectElement).value)}
                          >
                            ${AUTH_OPTIONS.map(
                              (opt) => html`
                              <option value=${opt.value} ?selected=${(config?.auth ?? "api-key") === opt.value}>${opt.label}</option>
                            `,
                            )}
                          </select>
                        </div>
                        <div class="models-config-row">
                          <label class="models-config-label">API Protocol</label>
                          <select
                            class="models-config-select"
                            .value=${config?.api ?? getDefaultApi(meta.id)}
                            ?disabled=${props.disabled}
                            @change=${(e: Event) => props.onPatch(["providers", meta.id, "api"], (e.target as HTMLSelectElement).value)}
                          >
                            ${API_OPTIONS.map(
                              (opt) => html`
                              <option value=${opt.value} ?selected=${(config?.api ?? getDefaultApi(meta.id)) === opt.value}>${opt.label}</option>
                            `,
                            )}
                          </select>
                        </div>
                      </div>
                      <div class="models-config-row models-config-row--inline">
                        <label class="models-toggle-label">
                          <input
                            type="checkbox"
                            ?checked=${config?.authHeader ?? true}
                            ?disabled=${props.disabled}
                            @change=${(e: Event) => props.onPatch(["providers", meta.id, "authHeader"], (e.target as HTMLInputElement).checked)}
                          />
                          <span>Include auth header</span>
                        </label>
                      </div>
                    </div>

                    ${renderCatalogModelsTable(catalogModels, meta.id, props)}

                    <div class="models-provider-card__actions">
                      ${
                        meta.docsUrl
                          ? html`
                            <a href=${meta.docsUrl} target="_blank" rel="noopener" class="models-docs-link">
                              ${icons.externalLink} Documentation
                            </a>
                          `
                          : nothing
                      }
                      <button
                        class="btn btn--sm btn--danger"
                        @click=${() => props.onPatch(["providers", meta.id], undefined)}
                      >
                        Remove Provider
                      </button>
                    </div>
                  `
                  : status !== "detected"
                    ? html`
                      <div class="models-provider-card__setup">
                        <p class="models-setup-hint">
                          ${
                            meta.envVars.length > 0
                              ? html`Set <code>${meta.envVars[0]}</code> environment variable or choose an auth method.`
                              : html`
                                  Configure this provider to use its models.
                                `
                          }
                        </p>

                        ${
                          authOptions.length > 0
                            ? html`
                              <div class="models-auth-options">
                                ${authOptions.map(
                                  (opt) => html`
                                  <button
                                    class="btn btn--sm ${opt.type === "oauth" ? "btn--primary" : ""}"
                                    title=${opt.description}
                                    @click=${() => {
                                      if (opt.type === "oauth" || opt.type === "token") {
                                        // Trigger auth flow
                                        props.onAuthProvider?.(meta.id, opt.type);
                                      } else {
                                        // Just enable provider with env var placeholder
                                        props.onPatch(["providers", meta.id], {
                                          baseUrl: getDefaultBaseUrl(meta.id),
                                          apiKey: meta.envVars[0] ? `\${${meta.envVars[0]}}` : "",
                                          auth: opt.type,
                                          models: [],
                                        });
                                      }
                                    }}
                                  >
                                    ${opt.type === "oauth" ? icons.zap : icons.plus} ${opt.label}
                                  </button>
                                `,
                                )}
                              </div>
                            `
                            : html`
                              <button
                                class="btn btn--sm"
                                @click=${() => {
                                  props.onPatch(["providers", meta.id], {
                                    baseUrl: getDefaultBaseUrl(meta.id),
                                    apiKey: "",
                                    models: [],
                                  });
                                }}
                              >
                                ${icons.plus} Configure Manually
                              </button>
                            `
                        }

                        ${
                          meta.docsUrl
                            ? html`
                              <a href=${meta.docsUrl} target="_blank" rel="noopener" class="models-docs-link">
                                ${icons.externalLink} Setup Guide
                              </a>
                            `
                            : nothing
                        }
                      </div>
                    `
                    : nothing
              }
            </div>
    </div>
  `;
}

/** Render models from gateway catalog with enable/disable toggle */
function renderCatalogModelsTable(
  catalogModels: GatewayCatalogModel[],
  providerId: string,
  props: ModelsSettingsProps,
): TemplateResult {
  const modelCount = catalogModels.length;
  const disabledSet = new Set(props.value?.disabledModels ?? []);
  const enabledCount = catalogModels.filter(
    (m) => !disabledSet.has(`${providerId}/${m.id}`),
  ).length;

  if (modelCount === 0) {
    return html`
      <div class="models-empty">
        ${
          props.catalogLoading
            ? html`
                <div class="models-loading">
                  <div class="models-loading__spinner"></div>
                  <span>Loading models from gateway...</span>
                </div>
              `
            : html`
              <p>No models available from this provider.</p>
              <p class="models-empty__hint">
                Models will appear here once the gateway discovers them.
                Make sure the provider is properly configured and has valid credentials.
              </p>
              ${
                props.onRefreshModels
                  ? html`
                    <button class="btn btn--sm" @click=${() => props.onRefreshModels?.()}>
                      ${icons.refresh} Refresh Models
                    </button>
                  `
                  : nothing
              }
            `
        }
      </div>
    `;
  }

  const toggleModel = (modelId: string, enable: boolean) => {
    const fullId = `${providerId}/${modelId}`;
    const current = props.value?.disabledModels ?? [];
    let updated: string[];
    if (enable) {
      // Remove from disabled list
      updated = current.filter((id) => id !== fullId);
    } else {
      // Add to disabled list
      updated = current.includes(fullId) ? current : [...current, fullId];
    }
    props.onPatch(["disabledModels"], updated);
  };

  const toggleAll = (enable: boolean) => {
    const current = props.value?.disabledModels ?? [];
    const providerModelIds = catalogModels.map((m) => `${providerId}/${m.id}`);
    let updated: string[];
    if (enable) {
      // Remove all this provider's models from disabled list
      updated = current.filter((id) => !providerModelIds.includes(id));
    } else {
      // Add all this provider's models to disabled list
      const toAdd = providerModelIds.filter((id) => !current.includes(id));
      updated = [...current, ...toAdd];
    }
    props.onPatch(["disabledModels"], updated);
  };

  return html`
    <div class="models-list">
      <div class="models-list__header">
        <span class="models-list__title">Models (${enabledCount}/${modelCount} enabled)</span>
        <div class="models-list__actions">
          <button
            class="btn btn--xs btn--ghost"
            @click=${() => toggleAll(true)}
            title="Enable all models"
            ?disabled=${enabledCount === modelCount}
          >
            Enable All
          </button>
          <button
            class="btn btn--xs btn--ghost"
            @click=${() => toggleAll(false)}
            title="Disable all models"
            ?disabled=${enabledCount === 0}
          >
            Disable All
          </button>
          ${
            props.onRefreshModels
              ? html`
                <button
                  class="models-refresh-btn"
                  @click=${() => props.onRefreshModels?.()}
                  title="Refresh model catalog"
                >
                  ${icons.refresh}
                </button>
              `
              : nothing
          }
        </div>
      </div>
      <div class="models-catalog-grid">
        ${catalogModels.map((model) => {
          const fullId = `${providerId}/${model.id}`;
          const isEnabled = !disabledSet.has(fullId);
          const hasVision = model.input?.includes("image");
          const hasReasoning = model.reasoning;
          const displayName = model.name || model.id.split("/").pop() || model.id;

          return html`
            <div class="models-catalog-item ${isEnabled ? "" : "models-catalog-item--disabled"}">
              <div class="models-catalog-item__toggle">
                <label class="toggle-switch">
                  <input
                    type="checkbox"
                    .checked=${isEnabled}
                    @change=${(e: Event) => toggleModel(model.id, (e.target as HTMLInputElement).checked)}
                    ?disabled=${props.disabled}
                  />
                  <span class="toggle-switch__slider"></span>
                </label>
              </div>
              <div class="models-catalog-item__main">
                <div class="models-catalog-item__name" title=${model.id}>${displayName}</div>
                <div class="models-catalog-item__badges">
                  ${hasReasoning ? html`<span class="model-badge model-badge--reasoning" title="Reasoning">${icons.brain}</span>` : nothing}
                  ${hasVision ? html`<span class="model-badge model-badge--vision" title="Vision">${icons.eye}</span>` : nothing}
                </div>
              </div>
              <div class="models-catalog-item__meta">
                ${model.contextWindow ? html`<span class="models-catalog-item__ctx">${formatNumber(model.contextWindow)} ctx</span>` : nothing}
                <code class="models-catalog-item__id">${model.id}</code>
              </div>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

function getDefaultBaseUrl(providerId: string): string {
  const defaults: Record<string, string> = {
    anthropic: "https://api.anthropic.com",
    openai: "https://api.openai.com/v1",
    google: "https://generativelanguage.googleapis.com/v1beta",
    groq: "https://api.groq.com/openai/v1",
    xai: "https://api.x.ai/v1",
    openrouter: "https://openrouter.ai/api/v1",
    mistral: "https://api.mistral.ai/v1",
    ollama: "http://127.0.0.1:11434/v1",
    "amazon-bedrock": "https://bedrock-runtime.us-east-1.amazonaws.com",
    "github-copilot": "https://api.githubcopilot.com",
  };
  return defaults[providerId] ?? "";
}

export function renderModelsSettings(props: ModelsSettingsProps): TemplateResult {
  const value = props.value ?? {};
  const providers = value.providers ?? {};

  // Group gateway catalog models by provider
  const catalogByProvider = groupCatalogByProvider(props.gatewayCatalog);
  const totalModels = props.gatewayCatalog.length;

  // All cards are always expanded to allow configuration
  const getExpanded = (_id: string) => true;

  // Keep stable alphabetical order - don't reorder when providers get configured
  // This prevents jarring UX where cards jump around
  const sortedProviders = [...KNOWN_PROVIDERS].toSorted((a, b) => a.name.localeCompare(b.name));

  // Find any custom providers not in known list
  const customProviderIds = Object.keys(providers).filter(
    (id) => !KNOWN_PROVIDERS.some((p) => p.id === id),
  );

  // Also check catalog for providers not in known list
  const catalogProviderIds = Array.from(catalogByProvider.keys());
  const unknownCatalogProviders = catalogProviderIds.filter(
    (id) => !KNOWN_PROVIDERS.some((p) => p.id === id) && !customProviderIds.includes(id),
  );

  return html`
    <div class="models-settings">
      <div class="models-settings__header">
        <div class="models-settings__intro">
          <h3 class="models-settings__title">AI Providers</h3>
          <p class="models-settings__subtitle">
            ${
              totalModels > 0
                ? html`${totalModels} models available from ${catalogByProvider.size} providers.`
                : props.catalogLoading
                  ? html`
                      Loading models from gateway...
                    `
                  : html`
                      Configure providers below to enable models for your agents.
                    `
            }
          </p>
        </div>
        ${
          props.onRefreshModels
            ? html`
              <button class="btn btn--sm" @click=${() => props.onRefreshModels?.()}>
                ${icons.refresh} Refresh All
              </button>
            `
            : nothing
        }
      </div>

      <div class="models-providers-grid">
        ${sortedProviders.map((meta) => {
          const catalogModels = catalogByProvider.get(meta.id) || [];
          return renderProviderCard(
            meta,
            providers[meta.id],
            props.detectedProviders[meta.id],
            props,
            catalogModels,
            getExpanded(meta.id) ?? false,
            () => {
              /* Toggle logic would go here */
            },
          );
        })}
      </div>

      ${
        customProviderIds.length > 0 || unknownCatalogProviders.length > 0
          ? html`
            <div class="models-custom-section">
              <h4 class="models-section-title">Custom Providers</h4>
              ${[...customProviderIds, ...unknownCatalogProviders].map((id) => {
                const config = providers[id];
                const catalogModels = catalogByProvider.get(id) || [];
                const customMeta: ProviderMeta = {
                  id,
                  name: id,
                  description: config?.baseUrl ?? `${catalogModels.length} models`,
                  icon: icons.settings,
                  color: "#6B7280",
                  envVars: [],
                };
                return renderProviderCard(
                  customMeta,
                  config,
                  undefined,
                  props,
                  catalogModels,
                  true,
                  () => {},
                );
              })}
            </div>
          `
          : nothing
      }

      <div class="models-add-section">
        <button
          class="models-add-btn"
          @click=${() => {
            const id = prompt("Enter provider ID (e.g., my-provider):");
            if (id?.trim()) {
              props.onPatch(["providers", id.trim()], {
                baseUrl: "",
                apiKey: "",
                models: [],
              });
            }
          }}
        >
          ${icons.plus}
          <span>Add Custom Provider</span>
        </button>
      </div>

      ${
        value.bedrockDiscovery !== undefined
          ? html`
            <div class="models-bedrock-discovery">
              <h4 class="models-section-title">Bedrock Discovery</h4>
              <div class="models-config-row">
                <label class="models-toggle-label">
                  <input
                    type="checkbox"
                    ?checked=${value.bedrockDiscovery?.enabled}
                    ?disabled=${props.disabled}
                    @change=${(e: Event) =>
                      props.onPatch(
                        ["bedrockDiscovery", "enabled"],
                        (e.target as HTMLInputElement).checked,
                      )}
                  />
                  <span>Auto-discover Bedrock models</span>
                </label>
              </div>
              ${
                value.bedrockDiscovery?.enabled
                  ? html`
                    <div class="models-config-row">
                      <label class="models-config-label">Region</label>
                      <input
                        type="text"
                        class="models-config-input"
                        .value=${value.bedrockDiscovery?.region ?? ""}
                        ?disabled=${props.disabled}
                        @input=${(e: Event) =>
                          props.onPatch(
                            ["bedrockDiscovery", "region"],
                            (e.target as HTMLInputElement).value,
                          )}
                        placeholder="us-east-1"
                      />
                    </div>
                  `
                  : nothing
              }
            </div>
          `
          : nothing
      }
    </div>
  `;
}
