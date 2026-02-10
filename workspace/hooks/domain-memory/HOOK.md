---
name: domain-memory
description: "Domain-scoped memory injection at session bootstrap"
metadata:
  {
    "openclaw":
      {
        "emoji": "🧬",
        "events": ["agent:bootstrap"],
        "install": [{ "id": "workspace", "kind": "workspace", "label": "Workspace hook" }],
      },
  }
---

# Domain Memory Hook

根據 session 的 chat_id 判斷所屬 domain，在 bootstrap 階段注入對應的 domain memory 檔案。

## 目的

防止跨 domain 記憶污染。例如：BG666 session 只載入 bg666 domain memory，不載入幣塔/TC 的。

## 機制

1. 從 `sessionKey` 解析 chat_id
2. 查表得到 domain（bg666/bita/tc/edu/sys）
3. 讀取 `memory/domains/{domain}.md`
4. 注入到 `bootstrapFiles` 陣列

## 事件

監聽 `agent:bootstrap` 事件，在系統提示組裝前介入。

## Domain Memory 檔案

| Domain | 檔案                      |
| ------ | ------------------------- |
| bg666  | `memory/domains/bg666.md` |
| bita   | `memory/domains/bita.md`  |
| tc     | `memory/domains/tc.md`    |
