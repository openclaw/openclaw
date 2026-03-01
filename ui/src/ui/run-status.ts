import { RUN_PHASE_LABELS, RUN_PHASE_SUFFIX_LABELS } from "./data/run-phase-labels.ts";

export type RunPhase = string;

function normalizeLevel(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function toDisplayLevel(
  value: string | null | undefined,
  mode: "standard" | "manual" = "standard",
): string {
  const normalized = normalizeLevel(value);
  if (!normalized) {
    return "Default";
  }
  if (
    mode === "manual" &&
    (normalized === "high" || normalized === "xhigh" || normalized === "deep")
  ) {
    return "Deep";
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function formatStatusBarReasoningLabel(input: {
  configured: string | null | undefined;
  effective: string | null | undefined;
}): string {
  const configured = normalizeLevel(input.configured);
  const effective = normalizeLevel(input.effective);
  if (configured === "auto") {
    return effective ? `Auto -> ${toDisplayLevel(effective)}` : "Auto";
  }
  if (configured && configured !== "off") {
    return `Manual: ${toDisplayLevel(effective ?? configured, "manual")}`;
  }
  if (effective && effective !== "off") {
    return toDisplayLevel(effective);
  }
  return "Default";
}

export function formatTickerReasoningLabel(input: {
  configured: string | null | undefined;
  effective: string | null | undefined;
}): string {
  const configured = normalizeLevel(input.configured);
  const effective = normalizeLevel(input.effective);
  if (effective && effective !== "off") {
    return toDisplayLevel(effective);
  }
  if (configured && configured !== "auto" && configured !== "off") {
    return toDisplayLevel(configured);
  }
  return "Default";
}

function normalizePhaseId(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function fallbackSingleWord(value: string): string | null {
  const parts = value.split(/[^a-z0-9]+/).filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  return parts[parts.length - 1];
}

export function resolveRunPhaseLabel(phaseId: string | null | undefined): string {
  const phase = normalizePhaseId(phaseId);
  if (!phase) {
    return "processing";
  }
  const direct = RUN_PHASE_LABELS[phase];
  if (direct) {
    return direct;
  }
  const fallback = fallbackSingleWord(phase);
  return fallback || "processing";
}

export function resolveRunPhaseSuffixLabel(suffixId: string | null | undefined): string | null {
  const suffix = normalizePhaseId(suffixId);
  if (!suffix) {
    return null;
  }
  return RUN_PHASE_SUFFIX_LABELS[suffix] ?? fallbackSingleWord(suffix);
}
