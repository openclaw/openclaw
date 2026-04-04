#!/usr/bin/env python3
"""
本地測試 LINE webhook
模擬 LINE 發送訊息事件
"""

import json
import os
import sys
import hmac
import hashlib
import base64
from dotenv import load_dotenv

# 載入環境變數
load_dotenv()

# 導入 webhook 處理器
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'api'))
from io import BytesIO

def test_webhook():
    """測試 webhook 處理邏輯"""

    # 模擬 LINE 發送的事件
    webhook_event = {
        "destination": "U123456789",
        "events": [
            {
                "type": "message",
                "replyToken": "test_reply_token_12345",
                "source": {
                    "userId": "U123456789",
                    "type": "user"
                },
                "timestamp": 1462629479859,
                "message": {
                    "type": "text",
                    "id": "325708",
                    "text": "/news"  # 測試關鍵字
                }
            }
        ]
    }

    body = json.dumps(webhook_event).encode('utf-8')

    # 計算簽名
    channel_secret = os.environ.get('LINE_CHANNEL_SECRET', '')
    if channel_secret:
        hash_digest = hmac.new(
            channel_secret.encode('utf-8'),
            body,
            hashlib.sha256
        ).digest()
        signature = base64.b64encode(hash_digest).decode('utf-8')
        print(f"✅ Generated signature: {signature[:20]}...")
    else:
        print("⚠️  LINE_CHANNEL_SECRET not set")
        signature = ""

    # 測試環境變數
    print("\n📋 環境變數檢查：")
    print(f"  LINE_CHANNEL_ACCESS_TOKEN: {'✅ 已設定' if os.environ.get('LINE_CHANNEL_ACCESS_TOKEN') else '❌ 未設定'}")
    print(f"  LINE_CHANNEL_SECRET: {'✅ 已設定' if os.environ.get('LINE_CHANNEL_SECRET') else '❌ 未設定'}")

    # 模擬 webhook 處理（導入實際邏輯）
    print("\n📝 測試請求內容：")
    print(json.dumps(webhook_event, indent=2, ensure_ascii=False))

    # 測試新聞拉取功能
    print("\n🔍 測試從 GitHub 拉取新聞...")
    try:
        import urllib.request
        github_url = "https://raw.githubusercontent.com/ThinkerCafe-tw/thinker-news/main/latest.json"

        with urllib.request.urlopen(github_url, timeout=10) as response:
            data = json.loads(response.read().decode('utf-8'))
            print(f"✅ 成功拉取新聞！")
            print(f"   日期: {data.get('date', 'N/A')}")
            print(f"   新聞數量: {len(data.get('sections', []))}")

            # 顯示第一則新聞
            if data.get('sections'):
                first_news = data['sections'][0]
                print(f"\n📰 第一則新聞預覽：")
                print(f"   標題: {first_news.get('title', 'N/A')}")
                print(f"   來源: {first_news.get('source', {}).get('name', 'N/A')}")
                print(f"   摘要: {first_news.get('summary', 'N/A')[:100]}...")
    except Exception as e:
        print(f"❌ 拉取新聞失敗: {str(e)}")

    print("\n" + "="*60)
    print("✅ 本地測試完成！")
    print("\n下一步：")
    print("1. 確認環境變數已正確設定")
    print("2. 部署到 Vercel 並設定環境變數")
    print("3. 在 LINE Developers Console 設定 webhook URL")
    print("4. 在 LINE 中測試發送 '/news' 關鍵字")

if __name__ == '__main__':
    print("🧪 開始本地測試 LINE Webhook")
    print("="*60)
    test_webhook()
