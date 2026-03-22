# 測試清單 — 每次改完都要跑

## shadow_clone.py

- [ ] `python3 shadow_clone.py dashboard` — 儀表板正常顯示
- [ ] `python3 shadow_clone.py wave-report` — 數字合理（sent < total）
- [ ] `python3 shadow_clone.py prompts --limit 3` — 不出現已回覆過的用戶
- [ ] `python3 shadow_clone.py send` — 無 results 時顯示提示不 crash

## batch_reply.py

- [ ] `python3 batch_reply.py --dry-run --limit 5` — 分類正確、不出現 banned phrases
- [ ] 每個 category 的回覆跟帖文主題對齊
- [ ] dedup gate 實際攔截重複

## threads_reply.py

- [ ] `python3 threads_reply.py scan` — 不 crash、顯示 DB 統計
- [ ] `python3 threads_reply.py scan --all` — 分頁正確、不漏帖
- [ ] deep scan (L2) 找到子回覆

## deep_scan.py

- [ ] `python3 deep_scan.py` — autonomy 決策顯示
- [ ] →他人的留言不出現在→我

## review.html

- [ ] 本地開啟能載入資料（不是「沒有資料」）
- [ ] 左右滑動/鍵盤操作正常
- [ ] 完成後顯示統計

## hormone.py

- [ ] `python3 workspace/lib/hormone.py` — 不 crash、顯示 season/focus/triggers
- [ ] trigger 結果合理（不追假訊號）

## nerve.py

- [ ] `python3 -c "from nerve import pulse; pulse('test','test')"` — 不 crash
- [ ] .nerve 檔案更新

## DB 完整性

- [ ] `SELECT COUNT(*) FROM replies WHERE status='sent'` < `SELECT COUNT(*) FROM comments`
- [ ] 無 orphan replies（reply 的 comment_id 存在於 comments 表）
- [ ] 無 sending 狀態卡住

## API

- [ ] 帳號健康：`api_get(USER_ID/threads)` 回資料
- [ ] 發送測試：能 create + publish（用測試留言）

## 跨 session

- [ ] .hormone 可讀、TTL 未過期
- [ ] .nerve 最近 pulse < 15 分鐘
- [ ] hook 注入正確（ctx + stats + hormone + nerve）
