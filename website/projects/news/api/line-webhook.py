"""
LINE Bot Webhook Handler for Vercel Serverless Function
處理 LINE 用戶訊息，回覆每日新聞內容
"""

from http.server import BaseHTTPRequestHandler
import json
import os
import urllib.request
import urllib.error
import hashlib
import hmac
import base64

class handler(BaseHTTPRequestHandler):

    def do_POST(self):
        """處理 LINE Webhook POST 請求"""
        print("🔔 ===== LINE Webhook POST Request Received =====")
        try:
            # 讀取請求內容
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            print(f"📦 Received {len(body)} bytes from LINE")

            # 驗證 LINE 簽名
            signature = self.headers.get('X-Line-Signature', '')
            print(f"Received signature: {signature[:20] if signature else 'None'}...")
            print(f"Body length: {len(body)}")

            if not self.verify_signature(body, signature):
                print("❌ Signature verification failed")
                self.send_error(403, "Invalid signature")
                return

            print("✅ Signature verification passed")

            # 解析請求
            webhook_data = json.loads(body.decode('utf-8'))

            # 處理事件
            for event in webhook_data.get('events', []):
                if event['type'] == 'message' and event['message']['type'] == 'text':
                    self.handle_text_message(event)

            # 回應成功
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'status': 'ok'}).encode())

        except Exception as e:
            print(f"Error handling webhook: {str(e)}")
            self.send_error(500, f"Internal server error: {str(e)}")

    def verify_signature(self, body, signature):
        """驗證 LINE 簽名"""
        channel_secret = os.environ.get('LINE_CHANNEL_SECRET', '')
        if not channel_secret:
            print("⚠️  Warning: LINE_CHANNEL_SECRET not set")
            return True  # 開發階段可以暫時跳過驗證

        print(f"Channel Secret (first 10 chars): {channel_secret[:10]}...")

        hash_digest = hmac.new(
            channel_secret.encode('utf-8'),
            body,
            hashlib.sha256
        ).digest()

        expected_signature = base64.b64encode(hash_digest).decode('utf-8')

        print(f"Expected signature: {expected_signature[:20]}...")
        print(f"Received signature: {signature[:20] if signature else 'None'}...")

        is_valid = signature == expected_signature
        print(f"Signature match: {is_valid}")

        return is_valid

    def handle_text_message(self, event):
        """處理文字訊息"""
        user_message = event['message']['text'].strip().lower()

        # 觸發關鍵字
        trigger_keywords = ['/news', '新聞', 'news', '今日新聞', '每日新聞']

        if any(keyword in user_message for keyword in trigger_keywords):
            # 從 GitHub 拉取最新新聞
            news_content = self.fetch_latest_news()

            if news_content:
                # 發送新聞到 LINE
                self.send_line_message(
                    event['replyToken'],
                    news_content
                )
            else:
                # 發送錯誤訊息
                self.send_line_message(
                    event['replyToken'],
                    "抱歉，目前無法獲取新聞內容，請稍後再試。"
                )

    def fetch_latest_news(self):
        """從 GitHub 拉取最新新聞 JSON"""
        try:
            github_url = "https://raw.githubusercontent.com/ThinkerCafe-tw/thinker-news/main/latest.json"

            with urllib.request.urlopen(github_url, timeout=10) as response:
                data = json.loads(response.read().decode('utf-8'))

                # 組裝回覆訊息
                message = self.format_news_message(data)
                return message

        except urllib.error.URLError as e:
            print(f"Error fetching news from GitHub: {str(e)}")
            return None
        except Exception as e:
            print(f"Error parsing news: {str(e)}")
            return None

    def format_news_message(self, data):
        """格式化新聞訊息"""
        try:
            # 直接使用 line_content 欄位（與 n8n 相同）
            line_content = data.get('line_content', '')
            website_url = data.get('website_url', '')
            generated_at = data.get('generated_at', '')

            if not line_content:
                return "抱歉，新聞內容為空。"

            # 組裝最終訊息（與 n8n 相同格式）
            final_text = f"{line_content}\n\n🔗 完整內容：{website_url}"

            if generated_at:
                # 格式化時間：取前 16 字元並替換 T 為空格
                formatted_time = generated_at[:16].replace('T', ' ')
                final_text += f"\n\n⏰ 更新時間：{formatted_time}"

            return final_text

        except Exception as e:
            print(f"Error formatting message: {str(e)}")
            return "抱歉，新聞格式化失敗。"

    def send_line_message(self, reply_token, message):
        """發送 LINE 訊息"""
        try:
            channel_access_token = os.environ.get('LINE_CHANNEL_ACCESS_TOKEN', '')
            if not channel_access_token:
                print("Error: LINE_CHANNEL_ACCESS_TOKEN not set")
                return

            url = "https://api.line.me/v2/bot/message/reply"

            headers = {
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {channel_access_token}'
            }

            payload = {
                'replyToken': reply_token,
                'messages': [
                    {
                        'type': 'text',
                        'text': message
                    }
                ]
            }

            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode('utf-8'),
                headers=headers,
                method='POST'
            )

            with urllib.request.urlopen(req, timeout=10) as response:
                print(f"LINE message sent successfully: {response.status}")

        except urllib.error.HTTPError as e:
            error_body = e.read().decode('utf-8')
            print(f"Error sending LINE message: {e.code} - {error_body}")
        except Exception as e:
            print(f"Error sending LINE message: {str(e)}")

    def do_GET(self):
        """處理 GET 請求（用於健康檢查）"""
        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({
            'status': 'ok',
            'message': 'LINE Bot Webhook is running'
        }).encode())
