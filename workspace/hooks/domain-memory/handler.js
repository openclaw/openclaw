// Domain Memory Hook — 根據 session 的 chat_id 注入對應 domain memory
//
// 監聽事件：agent:bootstrap
// 功能：解析 sessionKey → 查 domain → 注入 memory/domains/{domain}.md
//
// 設計原則：
//   - 不阻塞 bootstrap（讀檔失敗 → 靜默跳過）
//   - 不修改現有 bootstrapFiles，只追加
//   - 主 agent 用 chat_id 路由，bita agent 直接注入 bita domain

import fs from "fs";
import path from "path";

// =============================================================================
// Domain 路由表（與 ROUTING.md 同步）
// =============================================================================

const ROUTES = {
  // bg666
  "-5262004625": "bg666",
  "-1003337225655": "bg666",
  "-5150278361": "bg666",
  "-5173465395": "bg666",
  "-1003506161262": "bg666",
  "-5000326699": "bg666",
  "-5210426893": "bg666",
  "-1003442940778": "bg666",
  5665640546: "bg666",
  5038335338: "bg666",
  5308534717: "bg666",
  8243974830: "bg666",
  7545465225: "bg666",

  // 24bet
  "-5299944691": "24bet",

  // bita
  "-1003849990504": "bita",
  "-5297227033": "bita",
  "-5070604096": "bita",
  "-5186655303": "bita",
  "-5023713246": "bita",
  "-5295280162": "bita",
  "-5030731997": "bita",
  "-5148508655": "bita",
  "-5159438640": "bita",

  // tc
  "-5135725975": "tc",
  "-5236959911": "tc",

  // edu
  "-5058107582": "edu",
  "-5131977116": "edu",

  // sys
  "-4938903123": "sys",
};

// Agent ID → domain 直接映射（用於專屬 agent）
const AGENT_DOMAIN_MAP = {
  bita: "bita",
  two: "bg666",
  andrew: "24bet",
};

// Domain → memory file 相對路徑（相對於 workspaceDir）
const DOMAIN_MEMORY_FILES = {
  bg666: "memory/domains/bg666.md",
  bita: "memory/domains/bita.md",
  tc: "memory/domains/tc.md",
  // 24bet 暫無獨立 domain memory
  // edu 暫無獨立 domain memory
};

// =============================================================================
// 從 sessionKey 提取 chat_id
// =============================================================================

// sessionKey 格式範例：
//   agent:main:telegram:group:-5262004625
//   agent:main:telegram:default:dm:8090790323
//   agent:bita:telegram:group:-5297227033
//   agent:main:telegram:group:-1001234567890:topic:99
function extractChatId(sessionKey) {
  if (!sessionKey) return null;

  // 嘗試匹配 group:chatId 或 dm:peerId 模式
  // 群組 chat_id 是負數，私聊是正數
  const patterns = [
    /:group:(-?\d+)/, // group chat
    /:dm:(\d+)/, // direct message
    /:channel:(-?\d+)/, // channel
  ];

  for (const pattern of patterns) {
    const match = sessionKey.match(pattern);
    if (match) {
      return match[1];
    }
  }

  // 也嘗試直接在 sessionKey 中搜索已知的 chat_id
  for (const chatId of Object.keys(ROUTES)) {
    if (sessionKey.includes(chatId)) {
      return chatId;
    }
  }

  return null;
}

// =============================================================================
// 解析 domain
// =============================================================================

function resolveDomain(sessionKey, agentId) {
  // 1. Agent ID 直接映射（專屬 agent）
  if (agentId && AGENT_DOMAIN_MAP[agentId]) {
    return AGENT_DOMAIN_MAP[agentId];
  }

  // 2. 從 sessionKey 提取 chat_id 查表
  const chatId = extractChatId(sessionKey);
  if (chatId && ROUTES[chatId]) {
    return ROUTES[chatId];
  }

  // 3. 無法判斷 → 返回 null（不注入任何 domain memory）
  return null;
}

// =============================================================================
// 讀取 domain memory 檔案
// =============================================================================

function loadDomainMemory(workspaceDir, domain) {
  const relativePath = DOMAIN_MEMORY_FILES[domain];
  if (!relativePath) return null;

  const fullPath = path.join(workspaceDir, relativePath);
  try {
    if (!fs.existsSync(fullPath)) {
      console.log(`[domain-memory] File not found: ${fullPath}`);
      return null;
    }
    const content = fs.readFileSync(fullPath, "utf-8");
    return { relativePath, fullPath, content };
  } catch (err) {
    console.error(`[domain-memory] Failed to read ${fullPath}:`, err.message);
    return null;
  }
}

// =============================================================================
// Handler
// =============================================================================

async function handler(event) {
  // 只處理 agent:bootstrap 事件
  if (event.type !== "agent" || event.action !== "bootstrap") {
    return;
  }

  const ctx = event.context || {};
  const { workspaceDir, bootstrapFiles, sessionKey, agentId } = ctx;

  if (!workspaceDir || !Array.isArray(bootstrapFiles)) {
    return;
  }

  // 解析 domain
  const domain = resolveDomain(sessionKey, agentId);
  if (!domain) {
    console.log(`[domain-memory] No domain resolved for session=${sessionKey} agent=${agentId}`);
    return;
  }

  // 讀取 domain memory
  const memoryFile = loadDomainMemory(workspaceDir, domain);
  if (!memoryFile) {
    console.log(`[domain-memory] No memory file for domain=${domain}`);
    return;
  }

  // 注入到 bootstrapFiles
  bootstrapFiles.push({
    name: memoryFile.relativePath,
    path: memoryFile.fullPath,
    content: memoryFile.content,
    missing: false,
  });

  console.log(
    `[domain-memory] Injected ${domain} domain memory (${memoryFile.content.length} chars) for session=${sessionKey}`,
  );
}

export default handler;
