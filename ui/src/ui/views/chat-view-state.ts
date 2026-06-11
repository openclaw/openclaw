import type { SlashCommandDef } from "../chat/slash-commands.ts";

interface ChatEphemeralState {
  slashMenuOpen: boolean;
  slashMenuItems: SlashCommandDef[];
  slashMenuIndex: number;
  slashMenuMode: "command" | "args";
  slashMenuCommand: SlashCommandDef | null;
  slashMenuArgItems: string[];
  slashMenuExpanded: boolean;
  searchOpen: boolean;
  searchQuery: string;
  pinnedExpanded: boolean;
}

function createChatEphemeralState(): ChatEphemeralState {
  return {
    slashMenuOpen: false,
    slashMenuItems: [],
    slashMenuIndex: 0,
    slashMenuMode: "command",
    slashMenuCommand: null,
    slashMenuArgItems: [],
    slashMenuExpanded: false,
    searchOpen: false,
    searchQuery: "",
    pinnedExpanded: false,
  };
}

export const chatEphemeralState = createChatEphemeralState();

/**
 * Reset chat view ephemeral state when navigating away.
 * Clears search/slash UI that should not survive navigation.
 */
export function resetChatViewState() {
  Object.assign(chatEphemeralState, createChatEphemeralState());
}
