# 影分身之術 — Loop Prompt

貼到 Claude Code session 的 /loop 執行：

```
/loop 15m 影分身自主循環：

1. 準備：
   cd /Users/sulaxd/clawd/workspace/tools/threads-reply && python3 shadow_clone.py prompts --limit 10
   讀取 shadow-clone-prompts.json

2. 如果有 prompts：
   開 N 個 Agent tool（並行），每個帶一個 prompt
   每個 Agent model=opus
   收集所有回覆

3. 結果寫入 shadow-clone-results.json：
   [{"comment_id": "...", "post_id": "...", "username": "...", "reply": "agent回覆"}]

4. 發送：
   python3 shadow_clone.py send

5. pulse 到 .nerve

6. 如果 prompts 是空的 → wave-report 然後做基建

規則：
- 每個 Agent 的 prompt 已包含所有規則（字數對等、不模板、預判三步）
- 不用額外加規則，直接執行
- 深夜 23:00-07:00 不跑（.hormone 說的）
```
