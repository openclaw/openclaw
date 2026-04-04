"""
AI 處理鏈
四段式處理：Gemini → OpenAI → OpenAI → Gemini

1. 數據煉金術師 (Data Alchemist) - Gemini
2. 科技導讀人 (Tech Narrator) - OpenAI
3. 總編輯 (Editor-in-Chief) - OpenAI
4. HTML 生成器 (HTML Generator) - Gemini
"""

import os
import logging
import json
import time
from typing import List, Dict, Callable, Any
from functools import wraps
import google.generativeai as genai
from openai import OpenAI

logger = logging.getLogger(__name__)

# ============================================
# 重試裝飾器
# ============================================

def retry_on_failure(max_retries: int = 2, delay: int = 3):
    """
    重試裝飾器

    Args:
        max_retries: 最大重試次數
        delay: 重試延遲（秒）
    """
    def decorator(func: Callable) -> Callable:
        @wraps(func)
        def wrapper(*args, **kwargs) -> Any:
            for attempt in range(max_retries + 1):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    if attempt < max_retries:
                        logger.warning(f"⚠️  {func.__name__} 第 {attempt + 1} 次嘗試失敗: {str(e)}")
                        logger.info(f"🔄 等待 {delay} 秒後重試...")
                        time.sleep(delay)
                    else:
                        logger.error(f"❌ {func.__name__} 在 {max_retries + 1} 次嘗試後仍然失敗")
                        raise
            return None
        return wrapper
    return decorator

# ============================================
# 環境變數配置
# ============================================

# API Keys
GEMINI_API_KEY = os.getenv('GEMINI_API_KEY')
OPENAI_API_KEY = os.getenv('OPENAI_API_KEY')

# Model Names
GEMINI_MODEL = os.getenv('GEMINI_MODEL', 'gemini-2.5-flash')
OPENAI_TECH_MODEL = os.getenv('OPENAI_TECH_MODEL', 'chatgpt-4o-latest')
OPENAI_EDITOR_MODEL = os.getenv('OPENAI_EDITOR_MODEL', 'chatgpt-4o-latest')

# Model Parameters
OPENAI_TECH_TEMP = float(os.getenv('OPENAI_TECH_TEMP', '0.7'))
OPENAI_EDITOR_TEMP = float(os.getenv('OPENAI_EDITOR_TEMP', '0.7'))
GEMINI_HTML_TEMP = float(os.getenv('GEMINI_HTML_TEMP', '0.3'))

# Retry Parameters
AI_MAX_RETRIES = int(os.getenv('AI_MAX_RETRIES', '2'))
AI_RETRY_DELAY = int(os.getenv('AI_RETRY_DELAY', '3'))

# ============================================
# API 配置
# ============================================

def setup_apis():
    """設置 API keys"""
    if not GEMINI_API_KEY:
        raise ValueError("❌ GEMINI_API_KEY 環境變數未設置")
    if not OPENAI_API_KEY:
        raise ValueError("❌ OPENAI_API_KEY 環境變數未設置")

    # 配置 Gemini
    genai.configure(api_key=GEMINI_API_KEY)

    # 配置 OpenAI
    openai_client = OpenAI(api_key=OPENAI_API_KEY)

    return openai_client


# ============================================
# 系統提示詞（與 n8n 完全一致）
# ============================================

DATA_ALCHEMIST_SYSTEM_PROMPT = """# 數據煉金術師 (Data Alchemist)

---

## ROLE (人格設定)
你是一位資深的「數據煉金術師」兼「新聞內容策展師」。你同時具備:
- 數據科學家的嚴謹分析能力  
- 頂尖內容策略師對市場脈動的敏銳嗅覺
- **新聞編輯的內容整理能力** (新增)

你的任務是將每日雜亂的 AI 新聞原料,提煉成**既有深度又易讀**的完整新聞內容。

## TARGET AUDIENCE PROFILE (目標讀者輪廓)
- **年齡:** 30 - 60 歲
- **背景:** 曾有 R 或 Python 資料分析經驗
- **興趣:** 對資料科學充滿好奇,渴望踏入 AI 領域
- **程度:** 入門級、小白 (Beginner)
- **閱讀需求:** 希望直接在網站獲得完整資訊,而非只看標題

## CORE MISSION (核心任務)
請嚴格遵循以下步驟,處理我提供的「原始新聞列表」:

1. **標題轉譯 (Headline Translation):** 將每一則英文標題,轉譯為繁體中文。風格必須「高度吸引人、符合台灣網路社群語感、能激發點擊慾望」。

2. **📰 完整內容摘要 (Detailed Content Summary)**
   為每篇文章生成 **3-4 個段落的完整新聞摘要**,包含:
   - **發生了什麼** (What happened)
   - **具體細節** (Key details) 
   - **影響範圍** (Impact scope)
   - **為什麼重要** (Significance)

2. **🎯 實用要點 (Practical Takeaways)** 
   為每篇新聞提煉出 2-3 個學員可直接應用的要點

3. **智慧分類 (Smart Categorization):** 歸入指定分類

4. **價值排序 (Value-based Ranking):** 根據對目標群體的價值排序

5. **JSON 輸出 (JSON Output):** 封裝成JSON格式

## AVAILABLE CATEGORIES (可用分類)
- "ai_applications_and_tools"
- "industry_trends_and_news"  
- "security_alerts"
- "perspectives_and_analysis"
- "other"

## OUTPUT FORMAT (JSON 結構)
```json
{
  "ai_applications_and_tools": [
    {
      "rank": 1,
      "title": "[轉譯後的中文標題]",
      "detailed_content": "[3-4段完整新聞內容摘要,讓讀者無需外跳就能完全理解新聞]",
      "practical_takeaways": [
        "學員可直接應用的要點1",
        "學員可直接應用的要點2"  
      ],
      "link": "[原文連結]"
    }
  ],
  "industry_trends_and_news": [],
  "security_alerts": [],
  "perspectives_and_analysis": [],
  "other": []
}
```

## 🎯 學習引導規則（引流優化）

在每則新聞的 `practical_takeaways` 最後，**自然地**加入一個學習引導項目：

**引導公式**：
「想{動詞}？{課程價值主張} → [了解課程](https://thinker.cafe/products/6)」

**撰寫原則**：
1. 必須與該則新聞的核心主題緊密相關
2. 使用「想{做什麼}？」開頭，製造共鳴
3. 突出課程的差異化優勢（100% 手機友善、實體小班、實戰導向）
4. CTA 文字變化（了解課程/查看詳情/立即報名/探索內容）
5. 長度：25-45 字

**範例對照表**：
| 新聞主題 | 學習引導 |
|---------|---------|
| Claude 3.7 Sonnet 發布 | 想親手打造自己的 AI 助理？實戰營教你從 Prompt 到 Agent 開發 → [了解課程](https://thinker.cafe/products/6) |
| OpenAI o1 推理模型 | 想掌握 AI 推理鏈的實戰應用？18 小時從零到 AI 專案上線 → [查看詳情](https://thinker.cafe/products/6) |
| GitHub Copilot 更新 | 想讓 AI 成為你的編程夥伴？手機就能學會 AI 協作開發 → [立即報名](https://thinker.cafe/products/6) |
| Anthropic API 新功能 | 想打造專屬的 AI 工具？實戰營帶你從 API 到產品化 → [探索內容](https://thinker.cafe/products/6) |
| AI 數據分析應用 | 想用 AI 加速你的數據分析工作？實體小班教你實戰技能 → [了解課程](https://thinker.cafe/products/6) |

## 重要提醒
- **絕對不要**輸出 JSON 以外的任何文字
- `detailed_content` 必須足夠詳細,讓讀者看完就知道具體發生了什麼
- `practical_takeaways` 的最後一項必須是學習引導（按照上述公式）
- 所有內容都要服務於「讓初學者能直接學習而不困惑」的目標"""

TECH_NARRATOR_SYSTEM_PROMPT = """# 科技導讀人 (Tech Narrator)

---

## ROLE (人格設定)
你是一位資深的「AI 科技新聞編輯」。你擁有:
- 技術佈道師 (Tech Evangelist) 的熱情與洞察
- 新聞編輯的內容組織能力 
- 教育工作者的解釋技巧 

你的核心任務是將完整的新聞內容,以**清晰易懂的方式**呈現給資料科學初學者。

## TARGET AUDIENCE PROFILE (目標讀者輪廓)
- **年齡:** 30 - 60 歲
- **背景:** 曾有 R 或 Python 資料分析經驗
- **興趣:** 對資料科學充滿好奇,渴望踏入 AI 領域
- **程度:** 入門級、小白 (Beginner)
- **閱讀期待:** 希望直接獲得完整新聞內容,而不只是推薦理由

## CORE MISSION (核心任務)
從「數據煉金術師」提供的 JSON 數據中,精選 8-10 則最值得閱讀的內容,並撰寫成一份**內容完整**的 Notion 日報。

## CONTENT STRUCTURE REVOLUTION (內容結構革命)

### ❌ 舊結構 (要避免的)
```
標題 → 推薦理由 → 短評 → 外連
```

### ✅ 新結構 (要採用的)  
```
標題 → 完整新聞內容 → 學習價值分析 → 外連(可選)
```

## WRITING GUIDELINES (寫作指南)

### 1. 內容優先原則
- **70% 篇幅**: 基於 `detailed_content` 撰寫完整新聞內容
- **20% 篇幅**: 學習價值分析 (為什麼重要)
- **10% 篇幅**: 實用建議

### 2. 新聞內容寫作要求
- 必須讓讀者看完就知道**具體發生了什麼**
- 包含關鍵細節:時間、地點、人物、事件、原因、影響
- 用初學者能理解的語言解釋技術概念
- **絕對不要**只寫推薦理由而忽略實際內容

### 3. 學習價值分析
- 簡潔說明這則新聞對他們的技能樹或職涯規劃的意義
- 避免過度行銷話術
- 重點在實用價值而非推銷

## OUTPUT FORMAT (輸出格式) - 【結構優化】
```json
{
  "notion_daily_report_text": "## 🤖 AI 科技日報精選\\n**日期:** [YYYY-MM-DD]\\n\\n### ✨ 今日必讀 TOP 3\\n\\n**1. [標題]**\\n🔧 分類:[中文分類]\\n\\n[完整新聞內容 - 3-4個段落,包含所有關鍵資訊]\\n\\n💡 **學習價值:** [為什麼對初學者重要,如何應用]\\n\\n🔗 [閱讀原文]([連結])\\n\\n**2. [下一則新聞...]**\\n\\n### 🛠 AI工具與應用焦點\\n[其他分類的新聞,同樣結構]\\n\\n### 📊 產業趨勢與新聞\\n[同樣結構]\\n\\n### 🔐 資安趨勢快訊  \\n[同樣結構]\\n\\n### 🌍 產業動態與AI職涯\\n[同樣結構]\\n\\n### 💡 深度觀點與建議\\n[同樣結構]\\n\\n---\\n\\n📬 **日報後記**\\n[整體趨勢分析和學習建議]"
}
```

## 重要提醒 
- **內容為王**:每則新聞必須包含完整的新聞內容,而不只是推薦理由
- **讀者體驗**:讀完應該知道具體發生了什麼,而不只是為什麼要關注
- **學習導向**:所有內容都要服務於初學者的學習需求
- **絕對不要**輸出任何 JSON 格式以外的文字"""

EDITOR_IN_CHIEF_SYSTEM_PROMPT = """# 總編輯 (Editor-in-Chief)


---

## ROLE (人格設定)
你是一位頂尖的「社群內容總編輯」兼「智能品管師」。你的超能力包括:
- 將深度長文蒸餾成瘋傳社群快訊的能力
- **自動檢測並修正內容錯誤的智能品管能力**
- **清理不適合公開發布內容的專業判斷**

## TARGET AUDIENCE PROFILE (目標讀者輪廓)
LINE群組中對 AI 與資料科學感興趣的初學者,需要快速可讀的懶人包。

## CONTEXT (情境)
你將收到一份詳細的【Notion 版 AI 日報】,需要提煉成適合LINE傳播的快訊。

## CORE MISSION (核心任務)
1. **內容提煉**:將長文報告提煉成LINE快訊
2. **🎯 今日學習焦點生成** **(新增功能)**:分析當日新聞主題,生成首屏學習引導
3. **🔧 智能品管** **(核心功能)**:自動檢測並修正以下問題

## INTELLIGENT QUALITY CONTROL (智能品管規則) 

### 🗓️ 日期智能修正
- **檢測**:如果內容中出現錯誤日期(如 2025-09-24)
- **修正**:自動校正為當前正確日期(如 2025-09-25)
- **適用範圍**:標題、內文、任何日期標示

### 🧹 生成痕跡清理
自動移除以下不適合公開的生成資訊:
- "由 n8n 高品質工作流程自動生成"
- "更新時間: 2025-XX-XX XX:XX"  
- "AI 工作流程處理"
- 任何包含 "n8n"、"自動生成"、"工作流程" 的技術說明

### 🔗 連結策略
- **不提供原文連結**:LINE版本專注於內容本身
- **導引策略**:讀者如需詳細資訊會自然前往完整日報網站

### 🏷️ Hashtags 格式優化
- 確保 hashtags 使用正確的 `#` 符號
- 排版美觀,適當間距
- 內容相關且有意義

## WRITING GUIDELINES (寫作指南)
- **提煉,而非重寫**:基於 Notion 版內容進行精煉
- **抓取主題**:找出最核心的 1-2 個趨勢作為主題
- **聚焦「So What」**:一針見血的價值分析

## 🎯 TODAY'S LEARNING FOCUS (今日學習焦點生成規則)

分析當日新聞的**共同技術主題**,生成一段首屏學習引導文案。

**生成邏輯**:
1. 識別今日新聞中出現最多的技術主題（如：AI Agent、Prompt Engineering、多模態應用）
2. 將這些主題與《AI 全能實戰營》的課程單元對應
3. 生成一段 2-3 句的引導文案

**輸出格式**:
```
learning_focus_text: "🎯 今日學習焦點\\n\\n今天的新聞涵蓋了 **{主題1}**、**{主題2}**、**{主題3}**，這些正是《AI 全能實戰營》{對應單元}的核心主題！課程用 18 小時實體教學，帶你從理論到實戰，100% 手機友善，限額 12 人小班制。\\n\\n[📚 查看完整課程內容](https://thinker.cafe/products/6)"
```

**主題對應表**（參考用）:
| 新聞關鍵字 | 課程單元 | 文案範例 |
|-----------|---------|---------|
| AI Agent, Automation, Workflow | 第 2-3 天 | 教你打造個人 AI 助理與自動化工作流 |
| Prompt Engineering, GPT, Claude | 第 1 天 | 從零開始掌握 Prompt 工程與 AI 對話技巧 |
| Vision, Image, Multimodal | 第 2 天 | 多模態 AI 應用實戰 |
| API, Integration, Development | 第 3 天 | API 整合到產品化部署 |
| Data Analysis, Insights | 第 1-2 天 | AI 加速你的數據分析工作 |

**撰寫原則**:
- 必須基於當日新聞的真實主題（不要硬套）
- 語氣保持 Cruz 風格（務實、不浮誇）
- 突出課程的差異化（實體、手機友善、小班制）
- 長度：60-100 字

## OUTPUT FORMAT (輸出格式) - 【擴展版】

**新增欄位**: `learning_focus_text`

你不必拘泥於固定格式,請根據當日新聞特色,選擇最吸引人的呈現方式:

**可以是重點突出型:**
```json
{
  "line_message_text": "🚨 AI重大突破!\\n\\n今天發生兩件大事:\\n✅ [第一件大事]\\n✅ [第二件大事]\\n\\n為什麼重要?\\n[簡潔有力的分析]\\n\\n#[標籤] #[標籤]",
  "learning_focus_text": "🎯 今日學習焦點\\n\\n今天的新聞涵蓋了 **{主題1}**、**{主題2}**、**{主題3}**，這些正是《AI 全能實戰營》{對應單元}的核心主題！課程用 18 小時實體教學，帶你從理論到實戰，100% 手機友善，限額 12 人小班制。\\n\\n[📚 查看完整課程內容](https://thinker.cafe/products/6)"
}
```

**可以是故事敘述型:**
```json
{
  "line_message_text": "【今日AI圈大事件】\\n\\n想像一下:\\n[情境描述]\\n\\n所以今天同時出現了:\\n🔓 [現象一]\\n🔒 [現象二]\\n\\n#[標籤] #[標籤]",
  "learning_focus_text": "[同上格式，基於當日主題生成]"
}
```

**或是問答引導型:**
```json
{
  "line_message_text": "❓ 今天AI圈最熱的話題?\\n\\n答案:「[核心主題]」\\n\\n🎯 [重點一]\\n🛡️ [重點二]\\n\\n這組合意味著什麼?\\n[深層意義]\\n\\n#[標籤] #[標籤]",
  "learning_focus_text": "[同上格式，基於當日主題生成]"
}
```

**核心原則:**
- 格式生動有趣,避免死板
- 適合手機螢幕閱讀
- 引發分享慾望

## QUALITY CONTROL CHECKLIST (品管檢查清單)
在輸出前,請確認已完成:
- ✅ 日期已校正為正確日期
- ✅ 所有生成痕跡已清除
- ✅ 無效連結已移除
- ✅ Hashtags 格式正確美觀
- ✅ 內容適合公開分享
- ✅ **learning_focus_text 已生成**（必須包含）
- ✅ 學習焦點基於真實新聞主題（不硬套）
- ✅ 符合 JSON 格式要求

## 重要提醒
- **品質優先**:寧可多花時間檢查,也不要發出有問題的內容
- **用戶體驗**:LINE讀者看到的應該是專業、乾淨、有價值的內容
- **智能化**:讓手動修正成為過去式,一次生成就完美
- **絕對不要**輸出任何 JSON 格式以外的文字"""


# ============================================
# AI 處理函數
# ============================================

@retry_on_failure(max_retries=AI_MAX_RETRIES, delay=AI_RETRY_DELAY)
def process_with_data_alchemist(filtered_news: List[Dict], today_date: str) -> str:
    """
    數據煉金術師 - 使用 Gemini
    包含自動重試機制

    Args:
        filtered_news: 篩選後的新聞列表
        today_date: 今日日期

    Returns:
        JSON 格式的處理結果
    """
    logger.info("⚗️  數據煉金術師處理中...")
    
    # 準備新聞數據
    news_data = []
    for item in filtered_news:
        news_data.append({
            'title': item['title'],
            'link': item['link'],
            'content': item['content']
        })
    
    # 構建 prompt
    user_prompt = f"""新聞標題
{json.dumps([n['title'] for n in news_data], ensure_ascii=False, indent=2)}

超鏈結
{json.dumps([n['link'] for n in news_data], ensure_ascii=False, indent=2)}

新聞內容
{json.dumps([n['content'] for n in news_data], ensure_ascii=False, indent=2)}

今日日期
{today_date}"""
    
    try:
        # 調用 Gemini API
        model = genai.GenerativeModel(
            model_name=GEMINI_MODEL,
            system_instruction=DATA_ALCHEMIST_SYSTEM_PROMPT
        )
        
        response = model.generate_content(user_prompt)
        output = response.text
        
        logger.info("✅ 數據煉金術師處理完成")
        return output
        
    except Exception as e:
        logger.error(f"❌ 數據煉金術師處理失敗: {str(e)}")
        raise


@retry_on_failure(max_retries=AI_MAX_RETRIES, delay=AI_RETRY_DELAY)
def process_with_tech_narrator(alchemist_json: Dict, today_date: str) -> str:
    """
    科技導讀人 - 使用 OpenAI
    包含自動重試機制

    Args:
        alchemist_json: 數據煉金術師的 JSON 輸出
        today_date: 今日日期

    Returns:
        JSON 格式的處理結果
    """
    logger.info("📰 科技導讀人處理中...")

    openai_client = setup_apis()

    # 構建 prompt
    user_prompt = f"""數據煉金術師 OUTPUT: {json.dumps(alchemist_json, ensure_ascii=False)}

今日日期
{today_date}"""

    try:
        response = openai_client.chat.completions.create(
            model=OPENAI_TECH_MODEL,
            messages=[
                {"role": "system", "content": TECH_NARRATOR_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt}
            ],
            temperature=OPENAI_TECH_TEMP
        )

        output = response.choices[0].message.content

        logger.info("✅ 科技導讀人處理完成")
        return output

    except Exception as e:
        logger.error(f"❌ 科技導讀人處理失敗: {str(e)}")
        raise


@retry_on_failure(max_retries=AI_MAX_RETRIES, delay=AI_RETRY_DELAY)
def process_with_editor_in_chief(narrator_json: Dict, today_date: str) -> str:
    """
    總編輯 - 使用 OpenAI
    包含自動重試機制

    Args:
        narrator_json: 科技導讀人的 JSON 輸出
        today_date: 今日日期

    Returns:
        JSON 格式的處理結果
    """
    logger.info("✍️  總編輯處理中...")

    openai_client = setup_apis()

    # 構建 prompt
    notion_text = narrator_json.get('notion_daily_report_text', '')
    user_prompt = f"""【Notion 版 AI 日報】:
{notion_text}

今日日期
{today_date}"""

    try:
        response = openai_client.chat.completions.create(
            model=OPENAI_EDITOR_MODEL,
            messages=[
                {"role": "system", "content": EDITOR_IN_CHIEF_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt}
            ],
            temperature=OPENAI_EDITOR_TEMP
        )

        output = response.choices[0].message.content

        logger.info("✅ 總編輯處理完成")
        return output
        
    except Exception as e:
        logger.error(f"❌ 總編輯處理失敗: {str(e)}")
        raise


@retry_on_failure(max_retries=AI_MAX_RETRIES, delay=AI_RETRY_DELAY)
def process_with_html_generator(notion_content: str, line_content: str, today_date: str) -> str:
    """
    HTML 生成器 - 使用 Gemini
    完全對齊 n8n 架構：給 AI 完整的 HTML 範本，讓 AI 照抄並替換內容

    Args:
        notion_content: Notion 版本的 Markdown 內容
        line_content: LINE 版本的 Markdown 內容
        today_date: 今日日期

    Returns:
        完整的 HTML 文檔（從 <!DOCTYPE html> 到 </html>）
    """
    logger.info("🎨 HTML 生成器處理中...")

    # 設置 Gemini
    genai.configure(api_key=GEMINI_API_KEY)
    model = genai.GenerativeModel(GEMINI_MODEL)

    # System prompt - 對齊 n8n 的設定
    system_prompt = """你是專業的版面管理 Agent，專門負責確保網頁格式完全一致。

核心職責:
1. 嚴格按照提供的標準範本格式
2. 保持 CSS 樣式完全相同
3. 確保 HTML 結構完全一致
4. 不得添加任何額外的說明文字
5. 輸出純淨的 HTML 代碼

格式要求:
- 完全複製範本的 CSS 樣式
- 保持相同的 HTML 結構
- 只替換內容，不改變格式
- 特別注意 LINE 精華版區塊的粉紅色漸層
- 確保響應式設計和動畫效果
- 絕對不在 </html> 後面添加任何文字

**關鍵轉換規則（非常重要）:**
1. 看到 Markdown 中的 `💡 **學習價值:**` 或 `💡 學習價值：` 段落時
2. 必須將整個段落包裝在 <div class="highlight-box"> 裡面
3. 範例中的每個新聞項目都有 highlight-box，你也要為每個項目都生成
4. highlight-box 的結構：
   <div class="highlight-box">
       <strong>💡 學習價值：</strong><br>
       學習價值的內容文字...
   </div>

**重要警告:**
- 輸出結束於 </html> 標籤
- 不得添加任何解釋或說明文字
- 不得輸出 markdown 代碼塊標記"""

    # User prompt - 完全對齊 n8n 的 prompt
    user_prompt = f"""請基於以下標準範本，將 n8n 新聞內容格式化為完全相同的格式。

標準範本 HTML:
<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>2025-09-23 AI 科技日報 | Thinker News</title>
    <meta name="description" content="Nvidia投資OpenAI巨額資金，AI安全挑戰並存 - 今日AI科技重點新聞精選">
    <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🤖</text></svg>">
    <style>
        * {{
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }}

        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Microsoft JhengHei', sans-serif;
            line-height: 1.7;
            color: #333;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
        }}

        .container {{
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
        }}

        .back-link {{
            display: inline-block;
            margin-bottom: 20px;
            color: white;
            text-decoration: none;
            background: rgba(255, 255, 255, 0.2);
            padding: 10px 20px;
            border-radius: 20px;
            transition: all 0.3s ease;
            backdrop-filter: blur(10px);
        }}

        .back-link:hover {{
            background: rgba(255, 255, 255, 0.3);
            transform: translateX(-5px);
        }}

        .article-header {{
            text-align: center;
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 40px 30px;
            margin-bottom: 30px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
        }}

        .article-date {{
            font-size: 1.1em;
            color: #667eea;
            font-weight: 600;
            margin-bottom: 15px;
        }}

        .article-title {{
            font-size: 2.2em;
            font-weight: 800;
            margin-bottom: 20px;
            background: linear-gradient(45deg, #667eea, #764ba2);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            line-height: 1.3;
        }}

        .article-subtitle {{
            font-size: 1.2em;
            color: #666;
            font-weight: 400;
        }}

        .content-section {{
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 40px;
            margin-bottom: 30px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
        }}

        .content-section h2 {{
            color: #667eea;
            font-size: 1.6em;
            margin-bottom: 20px;
            border-bottom: 2px solid #667eea;
            padding-bottom: 10px;
            font-weight: 700;
        }}

        .content-section h3 {{
            color: #555;
            font-size: 1.3em;
            margin: 25px 0 15px;
            font-weight: 600;
        }}

        .content-section p {{
            margin-bottom: 15px;
            line-height: 1.7;
            font-size: 1.05em;
        }}

        .content-section ul {{
            margin: 15px 0;
            padding-left: 20px;
        }}

        .content-section li {{
            margin-bottom: 10px;
            line-height: 1.6;
        }}

        .highlight-box {{
            background: linear-gradient(135deg, #667eea20, #764ba220);
            border-left: 4px solid #667eea;
            padding: 20px;
            margin: 20px 0;
            border-radius: 0 15px 15px 0;
        }}

        .news-link {{
            color: #667eea;
            text-decoration: none;
            font-weight: 600;
            transition: all 0.3s ease;
        }}

        .news-link:hover {{
            color: #764ba2;
            text-decoration: underline;
        }}

        .external-link::after {{
            content: " 🔗";
            font-size: 0.8em;
        }}

        .footer-nav {{
            text-align: center;
            padding: 30px;
            color: white;
        }}

        .nav-button {{
            display: inline-block;
            background: rgba(255, 255, 255, 0.2);
            color: white;
            text-decoration: none;
            padding: 12px 24px;
            border-radius: 25px;
            margin: 0 10px;
            transition: all 0.3s ease;
            backdrop-filter: blur(10px);
        }}

        .nav-button:hover {{
            background: rgba(255, 255, 255, 0.3);
            transform: translateY(-2px);
        }}

        @media (max-width: 600px) {{
            .container {{
                padding: 15px;
            }}

            .article-header {{
                padding: 25px 20px;
            }}

            .article-title {{
                font-size: 1.8em;
            }}

            .content-section {{
                padding: 25px;
            }}
        }}
    </style>
</head>
<body>
    <div class="container">
        <a href="./index.html" class="back-link">← 返回首頁</a>

        <header class="article-header">
            <div class="article-date">📅 2025年9月23日</div>
            <h1 class="article-title">🤖 AI 科技日報精選</h1>
            <p class="article-subtitle">Nvidia投資OpenAI巨額資金，AI安全挑戰並存</p>
        </header>

        <div class="content-section">
            <h2>✨ 今日必讀 TOP 3</h2>

            <h3>1. Nvidia投資OpenAI高達1000億美元</h3>
            <p>Nvidia 與 OpenAI 達成協議，部署價值10千萬瓦的 AI 晶片，目的為推動下一代的ChatGPT。這顯示出 AI 領域的龍頭企業對於人工智慧未來潛力的高度信心。</p>
            <div class="highlight-box">
                <strong>💡 學習價值：</strong><br>
                這筆巨額投資標誌著AI基礎設施建設進入新階段，對於想要學習AI的初學者來說，這意味著更強大的工具和更多的學習資源即將到來。
            </div>
            <p><a href="https://techcrunch.com/2025/09/22/nvidia-plans-to-invest-up-to-100b-in-openai/" class="news-link external-link" target="_blank">閱讀更多</a></p>

            <h3>2. ShadowLeak漏洞透過OpenAI ChatGPT洩漏Gmail數據</h3>
            <p>這是一個重要的安全警報，OpenAI ChatGPT的深度研究代理中的零點擊漏洞可能讓攻擊者通過一封精心製作的電子郵件洩漏敏感的Gmail收件箱數據。</p>
            <div class="highlight-box">
                <strong>💡 學習價值：</strong><br>
                此事提醒我們，在 AI 的發展同時，我們也需要更加關注其帶來的安全問題。初學者應該學習 AI 資安的基礎知識。
            </div>
            <p><a href="https://thehackernews.com/2025/09/shadowleak-zero-click-flaw-leaks-gmail.html" class="news-link external-link" target="_blank">閱讀更多</a></p>

            <h3>3. 基礎設施交易推動AI繁榮</h3>
            <p>大型科技公司如 Meta、Oracle、Microsoft、Google 和 OpenAI 的大筆支出推動 AI 的興起。</p>
            <div class="highlight-box">
                <strong>💡 學習價值：</strong><br>
                這不僅反映出 AI 的重要性，更顯示出了其在產業界的影響力。初學者可以從中了解 AI 產業的發展趨勢。
            </div>
            <p><a href="https://techcrunch.com/2025/09/22/the-billion-dollar-infrastructure-deals-powering-the-ai-boom/" class="news-link external-link" target="_blank">閱讀更多</a></p>
        </div>

        <div class="content-section" style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white;">
            <h2 style="color: white; border-bottom: 3px solid white;">📱 LINE 精華版</h2>
            <div style="background: rgba(255,255,255,0.1); padding: 20px; border-radius: 15px; margin: 20px 0;">
                <h3>🤖 今日AI重點 (LINE版)</h3>
                <p><strong>💰 大新聞：</strong>Nvidia砸1000億美元投資OpenAI，推動下一代ChatGPT！</p>
            </div>

            <div style="text-align: center; margin-top: 20px;">
                <p style="font-size: 0.9em; opacity: 0.8;">
                    💡 此精華版專為LINE推送設計 | 完整分析請閱讀上方詳細報告
                </p>
            </div>
        </div>

        <div class="footer-nav">
            <a href="./index.html" class="nav-button">🏠 返回首頁</a>
            <a href="https://github.com/ThinkerCafe-tw/thinker-news" class="nav-button" target="_blank">⭐ GitHub</a>
        </div>
    </div>

    <script>
        // 頁面載入動畫
        document.addEventListener('DOMContentLoaded', function() {{
            const sections = document.querySelectorAll('.content-section');
            sections.forEach((section, index) => {{
                section.style.opacity = '0';
                section.style.transform = 'translateY(20px)';
                setTimeout(() => {{
                    section.style.transition = 'all 0.6s ease';
                    section.style.opacity = '1';
                    section.style.transform = 'translateY(0)';
                }}, index * 150);
            }});
        }});
    </script>
<script src="./thinker_secret_entrance.js"></script>
</body>
</html>

要替換的內容:
- 日期: {today_date}
- 新聞內容: 以下 n8n 內容

n8n 新聞內容:
{notion_content}

LINE消息版：
{line_content}

執行指令:
1. 使用標準範本的完整格式
2. 只替換日期和新聞內容
3. 保持所有 CSS 和 JavaScript 不變
4. 確保輸出結束於 </html>
5. 不要添加任何說明文字

請輸出完整的 HTML 代碼"""

    try:
        response = model.generate_content(
            f"{system_prompt}\n\n{user_prompt}",
            generation_config=genai.types.GenerationConfig(
                temperature=GEMINI_HTML_TEMP,
            )
        )

        output = response.text

        # 清理可能的 markdown 代碼塊標記
        if output.startswith('```html'):
            output = output[7:]
        if output.startswith('```'):
            output = output[3:]
        if output.endswith('```'):
            output = output[:-3]
        output = output.strip()

        logger.info("✅ HTML 生成器處理完成")
        return output

    except Exception as e:
        logger.error(f"❌ HTML 生成器處理失敗: {str(e)}")
        raise
