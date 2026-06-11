import { getSafeLocalStorage } from "../../local-storage.ts";
import type { AgentWorkflowOrderState } from "./agents.types.ts";

const WORKFLOW_ORDER_STORAGE_KEY = "openclaw.agentWorkflowMaps.orders.v1";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function normalizeAgentWorkflowOrders(value: unknown): AgentWorkflowOrderState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const normalized: AgentWorkflowOrderState = {};
  for (const [roomId, order] of Object.entries(value)) {
    const key = roomId.trim();
    if (key && isStringArray(order)) {
      normalized[key] = [...new Set(order.map((entry) => entry.trim()).filter(Boolean))];
    }
  }
  return normalized;
}

export function loadAgentWorkflowOrders(): AgentWorkflowOrderState {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return {};
  }
  const raw = storage.getItem(WORKFLOW_ORDER_STORAGE_KEY);
  if (!raw) {
    return {};
  }
  try {
    return normalizeAgentWorkflowOrders(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function saveAgentWorkflowOrders(orders: AgentWorkflowOrderState): void {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return;
  }
  storage.setItem(WORKFLOW_ORDER_STORAGE_KEY, JSON.stringify(normalizeAgentWorkflowOrders(orders)));
}
