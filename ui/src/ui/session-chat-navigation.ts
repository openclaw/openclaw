import type { UiSettings } from "./storage.ts";

export type SessionChatNavigationState = {
  sessionKey: string;
  chatMessage: string;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatRunId: string | null;
  settings: UiSettings;
  resetToolStream: () => void;
  resetChatScroll: () => void;
  applySettings: (next: UiSettings) => void;
  loadAssistantIdentity: () => Promise<void>;
  setTab: (tab: "chat") => void;
};

export function navigateToSessionChat(
  state: SessionChatNavigationState,
  sessionKey: string,
) {
  state.sessionKey = sessionKey;
  state.chatMessage = "";
  state.chatStream = null;
  state.chatStreamStartedAt = null;
  state.chatRunId = null;
  state.resetToolStream();
  state.resetChatScroll();
  state.applySettings({
    ...state.settings,
    sessionKey,
    lastActiveSessionKey: sessionKey,
  });
  void state.loadAssistantIdentity();
  state.setTab("chat");
}
