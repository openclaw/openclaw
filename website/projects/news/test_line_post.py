#!/usr/bin/env python3
"""
測試向 Vercel 發送 LINE webhook POST 請求
"""

import json
import hmac
import hashlib
import base64
import urllib.request
import os
from dotenv import load_dotenv

load_dotenv()

# LINE webhook 測試事件
webhook_event = {
    "destination": "U123456789",
    "events": []
}

body = json.dumps(webhook_event).encode('utf-8')

# 計算簽名
channel_secret = os.environ.get('LINE_CHANNEL_SECRET', '')
print(f"Channel Secret: {channel_secret}")
print(f"Body: {body.decode('utf-8')}")

hash_digest = hmac.new(
    channel_secret.encode('utf-8'),
    body,
    hashlib.sha256
).digest()

signature = base64.b64encode(hash_digest).decode('utf-8')
print(f"Signature: {signature}")

# 發送 POST 請求到 Vercel
url = "https://thinker-news.vercel.app/api/line-webhook"

headers = {
    'Content-Type': 'application/json',
    'X-Line-Signature': signature
}

try:
    req = urllib.request.Request(
        url,
        data=body,
        headers=headers,
        method='POST'
    )

    with urllib.request.urlopen(req, timeout=10) as response:
        print(f"\n✅ Response Status: {response.status}")
        print(f"Response: {response.read().decode('utf-8')}")

except urllib.error.HTTPError as e:
    print(f"\n❌ HTTP Error: {e.code} - {e.reason}")
    print(f"Response: {e.read().decode('utf-8')}")
except Exception as e:
    print(f"\n❌ Error: {str(e)}")
