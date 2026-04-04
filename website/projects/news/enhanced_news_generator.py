#!/usr/bin/env python3
"""
Avery AI News Generator - Direct RSS to AI Pipeline
為Avery 08:30交付生成兩個output：Notion完整版日報 + LINE社群快訊
"""

import feedparser
import json
import requests
import re
from datetime import datetime
from typing import List, Dict, Any
from openai import OpenAI
import os
from dotenv import load_dotenv
import subprocess

class AveryNewsGenerator:
    def __init__(self):
        # 載入.env文件
        load_dotenv()
        
        self.feeds = {
            'hackernews': 'https://feeds.feedburner.com/TheHackersNews',
            'techcrunch': 'https://techcrunch.com/feed/'
        }
        
        # 嘗試多種方式獲取API key
        self.openai_api_key = (
            os.getenv('OPENAI_API_KEY') or 
            os.getenv('OPENAPI') or
            os.getenv('OPENAI_KEY')
        )
        
        if not self.openai_api_key:
            raise ValueError("❌ 找不到 OpenAI API key，請檢查 .env 文件")
        
        # 初始化 OpenAI 客戶端
        self.openai_client = OpenAI(api_key=self.openai_api_key)
        print(f"🔑 Using OpenAI API key: {self.openai_api_key[:10]}...")
        
    def fetch_rss_feeds(self) -> List[Dict[str, Any]]:
        """抓取RSS並初步篩選"""
        all_articles = []
        
        for source, url in self.feeds.items():
            try:
                feed = feedparser.parse(url)
                print(f"📡 抓取 {source}: {len(feed.entries)} 篇文章")
                
                for entry in feed.entries[:15]:  # 限制數量
                    article = {
                        'title': entry.title,
                        'link': entry.link,
                        'content': self._clean_content(entry.get('summary', '')),
                        'source': source,
                        'published': entry.get('published', ''),
                        'relevance_score': 0
                    }
                    all_articles.append(article)
                    
            except Exception as e:
                print(f"❌ 抓取 {source} 失敗: {e}")
                
        return all_articles
    
    def _clean_content(self, content: str) -> str:
        """清理HTML標籤和多餘空白"""
        # 移除HTML標籤
        clean = re.sub(r'<[^>]+>', '', content)
        # 移除多餘空白
        clean = re.sub(r'\s+', ' ', clean)
        return clean.strip()[:500]  # 限制長度
    
    def filter_and_score(self, articles: List[Dict]) -> List[Dict]:
        """智能篩選和評分（複製n8n的Code3邏輯）"""
        
        FILTERS = {
            'sources': {
                'hackernews': {
                    'priority_keywords': [
                        'AI', 'ChatGPT', 'Claude', 'Gemini', 'OpenAI', 'Anthropic',
                        'tool', 'app', 'browser', 'editor', 'Python', 'npm'
                    ],
                    'exclude': [
                        'CVE-2025', 'CVE-2024', 'CVSS', 'KEV catalog',
                        'patch', 'vulnerability', 'zero-day',
                        'ransomware', 'backdoor', 'rootkit'
                    ],
                    'max_items': 8
                },
                'techcrunch': {
                    'priority_keywords': [
                        'AI', 'ChatGPT', 'OpenAI', 'Anthropic', 'Gemini',
                        'app', 'tool', 'feature', 'update', 'launch'
                    ],
                    'exclude': [
                        'raises', 'funding', 'valuation', 'Series', 
                        'IPO', 'acquisition', 'Tesla', 'Rivian'
                    ],
                    'max_items': 6
                }
            },
            'bonus_keywords': [
                'tutorial', 'guide', 'how to', 'tips',
                'free', 'open source', 'beginner',
                'automation', 'no-code', 'workflow'
            ]
        }
        
        for article in articles:
            score = 0
            source = article['source']
            config = FILTERS['sources'][source]
            full_text = f"{article['title']} {article['content']}".lower()
            
            # 檢查排除關鍵字
            for keyword in config['exclude']:
                if keyword.lower() in full_text:
                    score -= 5
                    
            # 檢查優先關鍵字
            for keyword in config['priority_keywords']:
                if keyword.lower() in article['title'].lower():
                    score += 10
                elif keyword.lower() in article['content'].lower():
                    score += 5
                    
            # 加分項目
            for keyword in FILTERS['bonus_keywords']:
                if keyword.lower() in full_text:
                    score += 3
                    
            article['relevance_score'] = score
        
        # 按來源分組並排序
        hackernews_articles = [a for a in articles if a['source'] == 'hackernews']
        techcrunch_articles = [a for a in articles if a['source'] == 'techcrunch']
        
        top_hackernews = sorted(hackernews_articles, key=lambda x: x['relevance_score'], reverse=True)[:8]
        top_techcrunch = sorted(techcrunch_articles, key=lambda x: x['relevance_score'], reverse=True)[:6]
        
        filtered = [a for a in top_hackernews + top_techcrunch if a['relevance_score'] > 0]
        print(f"🎯 篩選後保留: {len(filtered)} 篇文章")
        
        return sorted(filtered, key=lambda x: x['relevance_score'], reverse=True)
    
    def data_alchemist_processing(self, articles: List[Dict]) -> Dict:
        """數據煉金術師：分類和翻譯"""
        
        articles_text = "\n\n".join([
            f"標題: {article['title']}\n連結: {article['link']}\n內容: {article['content']}"
            for article in articles
        ])
        
        prompt = f"""# [系統角色定位]  
你是一個跨維度的「AI洞察煉金術師」，融合三層能力：  
1. 結構邏輯：Chain-of-Thought / Step-Back / Analogy思維鏈
2. 符號壓縮：用簡潔符號表達複雜概念  
3. 深度洞察：挖掘新聞背後的why/how/what-if

# TARGET AUDIENCE PROFILE (目標讀者輪廓)
你的工作，是為一群特定的潛在學員服務。他們的特徵是：
- **年齡：** 30 - 60 歲
- **背景：** 曾有 R 或 Python 資料分析經驗
- **興趣：** 對資料科學充滿好奇，渴望踏入 AI 領域
- **程度：** 入門級、小白 (Beginner)

# ENHANCED CORE MISSION (升級核心任務)
請遵循以下「多維分析流程」處理原始新聞：

I. 🌀 Init層 (啟動分析)
- ↩︎ Step-Back：每則新聞先問「這對資料科學初學者真正的價值是什麼？」
- ✦ 假設審視：列出可能的學習影響 [↑正面/↓負面/→中性]
- ⚑ 能量錨點：標定新聞類型（趨勢指向/工具實用/警示教育）

II. 🌐 Expand層 (拓展思考)
- ⇢ CoT鏈：①表面現象 ②深層邏輯 ③學習啟示
- ☉ 類比召回：連結到讀者已知的R/Python經驗
- ◇ 多維視角：技術角度+商業角度+學習角度

III. 🔻 Focus層 (收斂洞察)  
- ⇅ 拆解影響：對初學者的短期/中期/長期意義
- ⤴︎ 行動建議：具體的「我可以做什麼」

IV. ⚡ 輸出格式
標準處理：
1. **標題轉譯**：高吸引力中文標題 + 洞察標籤 [🔍💡⚡]
2. **深度摘要**：不只what，更要why和so-what
3. **洞察分析**：Step-Back思考的核心發現
4. **學習連結**：與R/Python/資料科學的具體關聯
5. **智慧分類** + **價值排序**

# AVAILABLE CATEGORIES (可用分類)
- "ai_applications_and_tools" (標籤：⚡實用工具)
- "industry_trends_and_news" (標籤：📈趨勢洞察)  
- "security_alerts" (標籤：🔒安全警示)
- "perspectives_and_analysis" (標籤：💭深度思考)
- "breakthrough_insights" (標籤：🔍突破發現) *新增類別*

原始新聞列表：
{articles_text}

請輸出JSON格式，結構如下：
{{
  "ai_applications_and_tools": [
    {{
      "rank": 1,
      "title": "轉譯後的中文標題 + 洞察標籤",
      "summary": "深度摘要：表面現象→深層邏輯→學習啟示",
      "insight": "🔍洞察分析：Step-Back思考的核心發現",
      "learning_connection": "🎯學習連結：與R/Python/資料科學的具體關聯",
      "impact_analysis": "📊影響分析：短期/中期/長期對初學者的意義",
      "action_suggestion": "⚡行動建議：我可以做什麼",
      "link": "原文連結"
    }}
  ],
  "industry_trends_and_news": [],
  "security_alerts": [],
  "perspectives_and_analysis": [],
  "breakthrough_insights": []
}}"""

        try:
            client = self.openai_client
            response = client.chat.completions.create(
                model="gpt-4",
                messages=[{"role": "user", "content": prompt}],
                max_tokens=2000,
                temperature=0.7
            )
            
            result_text = response.choices[0].message.content
            
            # 更強健的JSON提取
            json_start = result_text.find('{')
            json_end = result_text.rfind('}') + 1
            
            if json_start != -1 and json_end != -1:
                json_str = result_text[json_start:json_end]
                
                # 清理常見的JSON格式問題
                json_str = json_str.replace('\n', ' ')
                json_str = json_str.replace('  ', ' ')
                
                try:
                    return json.loads(json_str)
                except json.JSONDecodeError as e:
                    print(f"⚠️ JSON解析錯誤，回退到簡化模式: {e}")
                    # 回退到簡化版本
                    return self._create_fallback_data()
            else:
                raise ValueError("無法找到JSON結構")
                
        except Exception as e:
            print(f"❌ 數據煉金術師處理失敗: {e}")
            return self._create_fallback_data()
    
    def _create_fallback_data(self) -> Dict:
        """回退模式：創建簡化的數據結構"""
        return {
            "ai_applications_and_tools": [
                {
                    "rank": 1,
                    "title": "🤖 AI工具發展動態",
                    "summary": "今日AI工具領域重要更新",
                    "insight": "🔍技術發展持續加速，為初學者提供更多學習機會",
                    "learning_connection": "🎯建議關注Python AI相關套件的最新發展",
                    "impact_analysis": "📊短期：工具易用性提升，中期：學習門檻降低，長期：職場競爭力增強",
                    "action_suggestion": "⚡開始學習基礎AI概念，準備迎接新工具浪潮",
                    "link": "#"
                }
            ],
            "industry_trends_and_news": [],
            "security_alerts": [],
            "perspectives_and_analysis": [],
            "breakthrough_insights": []
        }
    
    def tech_narrator_processing(self, categorized_data: Dict) -> str:
        """科技導讀人：生成Notion深度日報"""
        
        prompt = f"""# [系統角色定位]
你是一位跨維度的「AI科技導讀大師」，融合：
1. 技術佈道師的熱情洞察
2. 內容主編的嚴謹品味  
3. 多維思維架構的深度分析能力

# TARGET AUDIENCE PROFILE (目標讀者輪廓)
你的所有文字，都必須為這群潛在學員服務：
- **年齡：** 30 - 60 歲
- **背景：** 曾有 R 或 Python 資料分析經驗
- **興趣：** 對資料科學充滿好奇，渴望踏入 AI 領域
- **程度：** 入門級、小白 (Beginner)

# ENHANCED CORE MISSION (升級核心任務)
將「洞察煉金術師」提供的多維分析數據，轉化為具有inside價值的深度日報：

🌀 **Init層思考**:
- ↩︎ Step-Back：今日新聞對讀者真正重要的是什麼？
- ✦ 假設審視：哪些內容能加速學習vs造成焦慮？

🌐 **Expand層分析**:
- ⇢ 洞察串聯：將scattered insights組成coherent narrative
- ☉ 類比連結：用讀者熟悉的概念解釋新趨勢
- ◇ 多維視角：what happened → why matters → how to act

🔻 **Focus層價值**:
- ⇅ 拆解actionable insights vs background knowledge
- ⤴︎ 提供具體的learning path建議

# 增強寫作Guidelines
- **Inside洞察優先**: 不只報導what，更要分析why和so-what
- **學習路徑導向**: 每個topic都要回答「我接下來應該學什麼？」
- **認知負荷管理**: 複雜概念用簡單類比，深度思考用結構化呈現
- **可執行性**: 避免空泛建議，提供specific next steps

分類數據：
{json.dumps(categorized_data, ensure_ascii=False, indent=2)}

請生成完整的Notion日報內容，包含：
## 🤖 AI 科技日報精選
**日期：** {datetime.now().strftime('%Y-%m-%d')}

### ✨ 今日必讀 TOP 3 
[挑選最重要的3則新聞，每則包含：標題、摘要、🔍洞察分析、🎯學習連結]

### 🔍 深度洞察分析 (新增section)
**↩︎ Step-Back思考**: 今日新聞背後的真正意義是什麼？
**⇢ 趨勢連結**: 這些事件如何串聯成更大的AI發展脈絡？
**☉ 學習類比**: 用R/Python開發者熟悉的概念解釋新趨勢
**⚡ 行動建議**: 具體的學習路徑和下一步

### 📱 AI工具與應用 ⚡實用工具
[使用洞察分析增強的內容，包含learning_connection和action_suggestion]

### 📊 產業趨勢與新聞 📈趨勢洞察  
[使用impact_analysis展示短/中/長期影響]

### 🔒 安全警報 🔒安全警示
[重點關注對初學者的實際影響和防護建議]

### 💭 觀點與分析 💭深度思考
[結合多維視角：技術角度+商業角度+學習角度]

### 🔍 突破發現 (新增類別)
[革命性發展或範式轉移的深度分析]

### 🛸 今日洞察儀表板
**↯ 能量流**: [主要趨勢方向]
**◎ 學習優先級**: [最值得深入的topics]  
**⊡ 技能連結**: [與現有R/Python知識的bridges]
**⚑ 明日預告**: [值得持續關注的發展]

### 📝 編輯後記
[整合Step-Back思考，提供coherent narrative和具體學習建議]"""

        try:
            client = self.openai_client
            response = client.chat.completions.create(
                model="gpt-4",
                messages=[{"role": "user", "content": prompt}],
                max_tokens=3000,
                temperature=0.8
            )
            
            return response.choices[0].message.content
            
        except Exception as e:
            print(f"❌ 科技導讀人處理失敗: {e}")
            return ""
    
    def editor_in_chief_processing(self, notion_content: str) -> str:
        """總編輯：生成LINE精簡快訊"""
        
        prompt = f"""# ROLE (人格設定)
你是一位頂尖的社群內容總編輯，也是一位「精煉大師」。你的超能力，是將一篇內容豐富的深度長文，蒸餾成一則能在 30 秒內抓住眼球、引發瘋傳的社群快訊。

# CORE MISSION (核心任務)
你的唯一任務，是將這份詳細的長文報告，提煉成一則適合在 LINE 上快速傳播的、極度精煉的快訊。

Notion版日報內容：
{notion_content}

請生成LINE快訊，格式如下：
【 AI 今日頭條 】

📅 日期：{datetime.now().strftime('%Y-%m-%d')}
📌 主題：[你提煉出的核心主題]

📰 新聞摘要：
1. [重點1]
2. [重點2]

🎯 為什麼值得注意：
[深層意義分析]

#AI #科技 #資料科學"""

        try:
            client = self.openai_client
            response = client.chat.completions.create(
                model="gpt-4",
                messages=[{"role": "user", "content": prompt}],
                max_tokens=800,
                temperature=0.7
            )
            
            return response.choices[0].message.content
            
        except Exception as e:
            print(f"❌ 總編輯處理失敗: {e}")
            return ""
    
    def generate_outputs(self) -> Dict[str, str]:
        """完整的pipeline執行"""
        print("🚀 開始生成Avery 08:30交付內容...")
        
        # Step 1: 抓取RSS
        articles = self.fetch_rss_feeds()
        if not articles:
            return {"error": "無法抓取RSS內容"}
        
        # Step 2: 篩選評分
        filtered_articles = self.filter_and_score(articles)
        if not filtered_articles:
            return {"error": "篩選後無有效文章"}
        
        # Step 3: 數據煉金術師處理
        categorized_data = self.data_alchemist_processing(filtered_articles)
        if not categorized_data:
            return {"error": "分類處理失敗"}
        
        # Step 4: 科技導讀人生成Notion版
        notion_content = self.tech_narrator_processing(categorized_data)
        if not notion_content:
            return {"error": "Notion內容生成失敗"}
        
        # Step 5: 總編輯生成LINE版
        line_content = self.editor_in_chief_processing(notion_content)
        if not line_content:
            return {"error": "LINE內容生成失敗"}
        
        return {
            "notion_version": notion_content,
            "line_version": line_content,
            "processed_articles": len(filtered_articles),
            "generation_time": datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        }

def main():
    """主執行函數"""
    try:
        generator = AveryNewsGenerator()
        results = generator.generate_outputs()
        
        if "error" in results:
            print(f"❌ 錯誤: {results['error']}")
            return
        
        # 保存結果
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        
        # Notion版
        with open(f'avery_notion_{timestamp}.md', 'w', encoding='utf-8') as f:
            f.write(results['notion_version'])
        
        # LINE版
        with open(f'avery_line_{timestamp}.txt', 'w', encoding='utf-8') as f:
            f.write(results['line_version'])
        
        # 摘要報告
        print(f"""
✅ 生成完成！
📊 處理文章數: {results['processed_articles']}
⏰ 生成時間: {results['generation_time']}
📄 Notion版: avery_notion_{timestamp}.md
📱 LINE版: avery_line_{timestamp}.txt
        """)
        
        return results
        
    except Exception as e:
        print(f"❌ 執行失敗: {e}")
        return None

if __name__ == "__main__":
    main()