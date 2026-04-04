#!/usr/bin/env python3
"""
LINE 洞察通知系統
當網站更新學習洞察時，自動發送到 LINE 群組
"""

import requests
import json
import os
from datetime import datetime
from typing import Dict, List, Optional

class LINEInsightsNotifier:
    def __init__(self):
        # LINE Bot Channel Access Token (需要設定)
        self.line_token = os.getenv('LINE_CHANNEL_ACCESS_TOKEN', '')
        self.line_api_url = 'https://api.line.me/v2/bot/message/push'
        
        # 設定群組ID (需要實際群組建立後取得)
        self.insights_group_id = os.getenv('LINE_INSIGHTS_GROUP_ID', '')
        
    def send_insight_notification(self, insight_data: Dict) -> bool:
        """
        發送洞察更新通知到 LINE 群組
        """
        try:
            message = self._format_insight_message(insight_data)
            
            payload = {
                'to': self.insights_group_id,
                'messages': [message]
            }
            
            headers = {
                'Authorization': f'Bearer {self.line_token}',
                'Content-Type': 'application/json'
            }
            
            response = requests.post(
                self.line_api_url, 
                headers=headers, 
                data=json.dumps(payload)
            )
            
            if response.status_code == 200:
                print(f"✅ 洞察通知已發送到 LINE 群組")
                return True
            else:
                print(f"❌ LINE 發送失敗: {response.status_code} - {response.text}")
                return False
                
        except Exception as e:
            print(f"❌ LINE 通知錯誤: {str(e)}")
            return False
    
    def _format_insight_message(self, insight_data: Dict) -> Dict:
        """
        格式化洞察訊息為 LINE 訊息格式
        """
        title = insight_data.get('title', '新洞察更新')
        content = insight_data.get('content', '')
        category = insight_data.get('category', '學習洞察')
        url = insight_data.get('url', 'https://thinkercafe-tw.github.io/thinker-news/')
        
        # 限制內容長度
        if len(content) > 200:
            content = content[:200] + "..."
            
        message_text = f"""🧠 {category}

📝 {title}

💡 {content}

🔗 完整內容：{url}

⏰ {datetime.now().strftime('%Y-%m-%d %H:%M')}
#ThinkerCafe #學習洞察"""

        return {
            "type": "text",
            "text": message_text
        }
    
    def send_website_update_notification(self) -> bool:
        """
        發送網站更新通知
        """
        insight_data = {
            'title': '網站洞察內容已更新！',
            'content': '我們剛剛更新了學習洞察區塊，包含最新的團隊協作經驗與AI開發心得。快來看看有什麼新的收穫吧！',
            'category': '🆕 更新通知',
            'url': 'https://thinkercafe-tw.github.io/thinker-news/#learning-insights'
        }
        
        return self.send_insight_notification(insight_data)

def main():
    """
    主要執行函數 - 可以被其他腳本調用
    """
    notifier = LINEInsightsNotifier()
    
    # 檢查是否有必要的環境變數
    if not notifier.line_token:
        print("⚠️ 請設定 LINE_CHANNEL_ACCESS_TOKEN 環境變數")
        print("📋 設定說明：")
        print("1. 建立 LINE Bot Channel")
        print("2. 取得 Channel Access Token")
        print("3. 設定環境變數：export LINE_CHANNEL_ACCESS_TOKEN='your_token'")
        return False
        
    if not notifier.insights_group_id:
        print("⚠️ 請設定 LINE_INSIGHTS_GROUP_ID 環境變數")
        print("📋 設定說明：")
        print("1. 建立 LINE 群組")
        print("2. 將 Bot 加入群組")
        print("3. 取得群組 ID")
        print("4. 設定環境變數：export LINE_INSIGHTS_GROUP_ID='group_id'")
        return False
    
    # 發送測試通知
    print("🚀 發送測試通知...")
    success = notifier.send_website_update_notification()
    
    if success:
        print("🎉 LINE 洞察通知系統設定完成！")
    else:
        print("❌ 通知發送失敗，請檢查設定")
    
    return success

if __name__ == "__main__":
    main()