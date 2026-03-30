/**
 * Chat State Slice
 * 
 * 聊天相关的状态：消息、输入、流式输出、附件等
 */

import { createContext } from '@lit/context';
import type { ChatAttachment, ChatQueueItem } from '../ui-types.ts';
import type { ChatModelOverride, ModelCatalogEntry } from '../types.ts';
import type { CompactionStatus, FallbackStatus } from '../app-tool-stream.ts';

export interface ChatState {
  // 会话标识
  sessionKey: string;
  
  // 消息状态
  chatLoading: boolean;
  chatSending: boolean;
  chatMessage: string;
  chatMessages: unknown[];
  chatToolMessages: unknown[];
  
  // 流式输出
  chatStreamSegments: Array<{ text: string; ts: number }>;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatRunId: string | null;
  
  // 状态指示
  compactionStatus: CompactionStatus | null;
  fallbackStatus: FallbackStatus | null;
  
  // 助手信息
  chatAvatarUrl: string | null;
  chatThinkingLevel: string | null;
  
  // 模型
  chatModelOverrides: Record<string, ChatModelOverride | null>;
  chatModelsLoading: boolean;
  chatModelCatalog: ModelCatalogEntry[];
  
  // 队列和附件
  chatQueue: ChatQueueItem[];
  chatAttachments: ChatAttachment[];
  chatManualRefreshInFlight: boolean;
  
  // 滚动状态
  chatNewMessagesBelow: boolean;
}

export const defaultChatState: ChatState = {
  sessionKey: '',
  chatLoading: false,
  chatSending: false,
  chatMessage: '',
  chatMessages: [],
  chatToolMessages: [],
  chatStreamSegments: [],
  chatStream: null,
  chatStreamStartedAt: null,
  chatRunId: null,
  compactionStatus: null,
  fallbackStatus: null,
  chatAvatarUrl: null,
  chatThinkingLevel: null,
  chatModelOverrides: {},
  chatModelsLoading: false,
  chatModelCatalog: [],
  chatQueue: [],
  chatAttachments: [],
  chatManualRefreshInFlight: false,
  chatNewMessagesBelow: false,
};

// Lit Context
export const chatStateContext = createContext<ChatState>('chat-state');