# ✅ Viona (Pricing Strategist) 設置完成

## 📦 完整檔案清單

```
.kiro/personas/pricing-strategist/
├── 📘 README.md                           # 總覽文件
├── 📗 PERSONA.md                          # 完整人格定義
├── 📙 TRIGGER.md                          # 觸發指令與流程
├── ⚡ QUICKSTART.md                       # 快速啟動指南
├── 📄 SETUP_COMPLETE.md                   # 本文件（設置完成說明）
├── 📋 CLAUDE_PRICING_STRATEGIST.md        # 切換用的人格檔案
├── 📊 templates/
│   └── report_template.md                 # 策略報告模板
├── 📁 reports/                            # 報告輸出目錄（待建立）
├── 📁 sessions/                           # 執行記錄目錄（待建立）
└── 📁 tools/                              # 分析工具目錄（待建立）
```

## 🎯 如何使用 Viona

### 完整流程（2 步驟）

#### 步驟 1：切換到 Viona 人格
```bash
.kiro/scripts/switch-persona.sh pricing-strategist
```

**預期輸出**：
```
🔄 人格切換系統
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 當前人格：Curator 人格定義
🎯 目標人格：pricing-strategist

💾 備份當前 CLAUDE.md...
✅ 備份完成：.kiro/personas/_backups/CLAUDE.md.backup_YYYYMMDD_HHMMSS

📝 切換到 Pricing Strategist 人格...

✅ 人格切換完成！

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 Pricing Strategist (Viona) 人格特性：
   • 課程定價診斷與分析
   • 設計定價策略方案
   • 市場定位分析
   • 數據驅動的商業建議

💡 啟動指令：
   在新對話中輸入：進行完整的定價診斷與策略規劃

📚 快速參考：
   cat .kiro/personas/pricing-strategist/QUICKSTART.md

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 提醒：
   重新開啟 Claude Code 或執行新的對話以載入新人格
```

#### 步驟 2：開啟新對話並啟動 Viona
在新的 Claude 對話視窗中輸入：

```
進行完整的定價診斷與策略規劃
```

### Viona 會自動完成

1. ✅ **資料收集**（2 分鐘）
   - 從 `.kiro/personas/curator/memory.json` 讀取所有課程定價
   - 識別已發布課程（course_id > 0）

2. ✅ **診斷分析**（5 分鐘）
   - 計算統計指標（平均、標準差、折扣率）
   - 識別異常定價
   - 列出問題清單

3. ✅ **策略設計**（10 分鐘）
   - 方案 A：保守調整
   - 方案 B：結構重整
   - 方案 C：價值重定位

4. ✅ **報告輸出**（3 分鐘）
   - 生成完整 Markdown 報告
   - 包含定價表、理由、效益、風險
   - 提供實施建議

## 📊 預期輸出

### 報告位置
```
.kiro/personas/pricing-strategist/reports/
└── YYYYMMDD_HHMMSS_pricing_strategy.md
```

### 報告內容
1. **現況診斷**
   - 課程定價總覽表
   - 統計指標分析
   - 問題識別清單

2. **3 個策略方案**
   - 完整定價表
   - 調整理由
   - 預期效益（營收影響）
   - 風險評估

3. **建議方案**
   - Viona 推薦哪個方案
   - 推薦理由
   - 實施步驟（分階段）
   - A/B 測試建議

### Session 記錄
```
.kiro/personas/pricing-strategist/sessions/
└── YYYYMMDD_HHMMSS_session.json
```

## 🔄 切換回其他人格

### 切回 Curator
```bash
.kiro/scripts/switch-persona.sh curator
```

### 切回預設人格
```bash
.kiro/scripts/switch-persona.sh default
```

## 🧪 測試驗證

### 驗證人格檔案存在
```bash
ls -lh .kiro/personas/pricing-strategist/CLAUDE_PRICING_STRATEGIST.md
```

**預期輸出**：
```
-rw-r--r--  1 user  staff   XX.XK Nov  2 XX:XX CLAUDE_PRICING_STRATEGIST.md
```

### 驗證 switch-persona.sh 已更新
```bash
.kiro/scripts/switch-persona.sh
```

**預期輸出（應包含 pricing-strategist）**：
```
使用方式：
  ./switch-persona.sh curator              # 切換到 Curator 人格（課程內容管理）
  ./switch-persona.sh pricing-strategist   # 切換到 Pricing Strategist 人格（定價策略）
  ./switch-persona.sh default              # 切換回預設人格
```

### 查看快速參考
```bash
cat .kiro/personas/pricing-strategist/QUICKSTART.md
```

## 📋 檢查清單

設置完成確認：

- [✅] 目錄結構建立完成
- [✅] PERSONA.md（人格定義）
- [✅] TRIGGER.md（觸發流程）
- [✅] QUICKSTART.md（快速指南）
- [✅] CLAUDE_PRICING_STRATEGIST.md（切換用檔案）
- [✅] report_template.md（報告模板）
- [✅] switch-persona.sh 已更新（支援 pricing-strategist）
- [✅] README.md 已更新（包含切換步驟）

使用前準備：

- [ ] 執行 `switch-persona.sh pricing-strategist`
- [ ] 開啟新的 Claude 對話
- [ ] 輸入觸發指令

## 💡 重要提醒

### 資料來源
- Viona 會從 `.kiro/personas/curator/memory.json` 讀取課程資料
- 確保 Curator 的 memory 是最新的

### 執行環境
- 需要在專案根目錄執行
- 建議使用新的 Claude 對話（避免上下文干擾）

### 時間預估
- 首次執行：~20 分鐘
- 後續執行：~15 分鐘

## 🎉 現在可以使用了！

**兩步驟啟動 Viona**：

1. 切換人格：
   ```bash
   .kiro/scripts/switch-persona.sh pricing-strategist
   ```

2. 開啟新對話，輸入：
   ```
   進行完整的定價診斷與策略規劃
   ```

---

**設置完成日期**：2025-11-02
**設置者**：Curator (協助 Cruz)
**狀態**：✅ 完全準備就緒

---

💡 **Viona 的話**：
「我已經準備好了。給我 20 分鐘，我會給你一份清晰、可執行、數據驅動的定價策略。」
