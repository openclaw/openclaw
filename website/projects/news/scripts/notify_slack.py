"""
Slack 通知模組
"""

import os
import sys
import json
import requests
import logging
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)


def send_slack_notification():
    """發送 Slack 通知"""
    try:
        webhook_url = os.getenv('SLACK_WEBHOOK_URL')
        
        if not webhook_url:
            logger.warning("⚠️  SLACK_WEBHOOK_URL 未設置,跳過 Slack 通知")
            return
        
        # 讀取 latest.json 獲取今日資訊
        latest_path = Path('latest.json')
        if not latest_path.exists():
            logger.error("❌ latest.json 不存在")
            return
        
        with open(latest_path, 'r', encoding='utf-8') as f:
            latest_data = json.load(f)
        
        date = latest_data.get('date', datetime.now().strftime('%Y-%m-%d'))
        url = latest_data.get('website_url', f'https://thinkercafe-tw.github.io/thinker-news/{date}.html')
        
        # 構建 Slack 消息
        message = {
            "text": f"Hey Avery 👋\n今天的新聞網誌~交給你啦!\n<{url}|點我看新聞>",
            "blocks": [
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": f"*🤖 AI 新聞日報生成完成！*\n\n📅 日期: {date}\n🔗 <{url}|查看今日新聞>"
                    }
                },
                {
                    "type": "divider"
                },
                {
                    "type": "context",
                    "elements": [
                        {
                            "type": "mrkdwn",
                            "text": "🎉 由 GitHub Actions 自動生成 | ⭐️ <https://github.com/ThinkerCafe-tw/thinker-news|GitHub Repo>"
                        }
                    ]
                }
            ]
        }
        
        # 發送請求
        response = requests.post(
            webhook_url,
            json=message,
            headers={'Content-Type': 'application/json'}
        )
        
        if response.status_code == 200:
            logger.info("✅ Slack 通知發送成功")
        else:
            logger.error(f"❌ Slack 通知發送失敗: {response.status_code} - {response.text}")
            
    except Exception as e:
        logger.error(f"❌ 發送 Slack 通知時出錯: {str(e)}")


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
    send_slack_notification()
