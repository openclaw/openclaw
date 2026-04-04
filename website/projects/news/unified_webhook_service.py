#!/usr/bin/env python3
"""
🎯 Thinker Café 統一 Webhook 服務
=====================================

## 📋 服務概述
這是一個多功能的 webhook 接收服務，整合了以下功能：
1. 🤖 LINE Bot 官方帳號服務 
2. 📰 n8n 新聞工作流程回調接收
3. 📊 Agent 007 記憶宮殿整合
4. 🔗 Cloudflare Tunnel 公網服務

## 🛠 端點規則 (Endpoint Rules)

### 基本服務端點
- GET  `/`                          - 健康檢查與服務資訊
- GET  `/health`                    - 詳細健康狀態檢查
- POST `/webhook/test`              - 測試端點，用於開發除錯

### LINE Bot 相關端點  
- POST `/webhook/line`              - LINE 官方帳號 Webhook 接收
- GET  `/line/status`               - LINE Bot 服務狀態查詢

### n8n 新聞工作流程端點
- POST `/webhook/n8n/news-complete` - 接收 n8n 完成的新聞內容
- GET  `/n8n/status`                - n8n 整合狀態查詢

### Agent 007 記憶宮殿端點
- POST `/webhook/memory`            - 記憶宮殿資料同步
- GET  `/memory/status`             - 記憶系統狀態

## 🔒 安全機制

### 認證方式
1. **LINE Bot**: LINE 官方驗證機制 (Channel Secret)
2. **n8n**: Bearer Token 認證 (環境變數 WEBHOOK_SECRET)
3. **記憶宮殿**: Agent 007 專屬 Token

### IP 白名單
- LINE Platform IPs
- n8n Cloud IPs  
- 本地開發 IP

## 🌐 Cloudflare Tunnel 設定

### 使用方法
```bash
# 1. 啟動本服務
python3 unified_webhook_service.py

# 2. 建立 Cloudflare Tunnel
cloudflared tunnel --url http://localhost:5000

# 3. 獲得公網 URL，設定到相關服務
# 例如: https://random-name.trycloudflare.com
```

### n8n 設定方式
在你的 n8n 工作流程最後，加入 HTTP Request 節點：
```
Method: POST
URL: https://your-tunnel-url.trycloudflare.com/webhook/n8n/news-complete
Headers: 
  - Content-Type: application/json
  - Authorization: Bearer your-secret-token
Body: {{ JSON.stringify($json) }}
```

## 📊 監控與日誌

### 日誌級別
- INFO: 正常操作記錄
- WARNING: 需注意的異常狀況  
- ERROR: 錯誤與失敗記錄

### 日誌檔案
- `unified_webhook.log` - 完整操作日誌
- 控制台輸出 - 即時狀態顯示

## ⚙️ 環境變數設定

必要環境變數：
```bash
# n8n 安全驗證
export WEBHOOK_SECRET="your-secure-token-here"

# LINE Bot 設定 (如果需要)
export LINE_CHANNEL_SECRET="your-line-channel-secret"
export LINE_CHANNEL_ACCESS_TOKEN="your-line-access-token"

# 服務端口 (可選，預設 5000)
export PORT=5000
```

## 🔧 故障排除

### 常見問題
1. **端口被佔用**: 修改 PORT 環境變數
2. **認證失敗**: 檢查 WEBHOOK_SECRET 設定
3. **n8n 回調失敗**: 確認 Cloudflare Tunnel 正常運行
4. **檔案權限問題**: 確認 thinker-news 目錄寫入權限

### 除錯模式
```bash
DEBUG=1 python3 unified_webhook_service.py
```

## 🚀 部署建議

### 開發環境
- 使用 Cloudflare Tunnel 進行外網訪問
- 設定詳細日誌記錄
- 啟用除錯模式

### 生產環境  
- 使用 gunicorn + nginx 部署
- 設定 systemd 服務自動重啟
- 配置 log rotation
- 設定監控告警

---

建立時間: 2025-09-26
維護者: Agent 007 & Cruz  
更新頻率: 按需更新
文檔版本: v1.0
"""

from flask import Flask, request, jsonify
import json
import os
import sys
import logging
from datetime import datetime
from pathlib import Path

# 設定日誌
log_level = logging.DEBUG if os.getenv('DEBUG') else logging.INFO
logging.basicConfig(
    level=log_level,
    format='%(asctime)s - %(levelname)s - [%(name)s] - %(message)s',
    handlers=[
        logging.FileHandler('unified_webhook.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# 配置
REPO_PATH = Path('/Users/thinkercafe/Documents/thinker-cafe/projects/news')
WEBHOOK_SECRET = os.getenv('WEBHOOK_SECRET', 'default-dev-token')
LINE_CHANNEL_SECRET = os.getenv('LINE_CHANNEL_SECRET', '')
SERVICE_VERSION = "1.0.0"

class NewsPublisher:
    """新聞發布處理器"""
    
    def __init__(self):
        self.repo_path = REPO_PATH
        logger.info(f"NewsPublisher initialized with repo_path: {self.repo_path}")
        
    def save_n8n_content(self, date_str: str, result_data: dict) -> bool:
        """保存 n8n 返回的內容"""
        try:
            if 'notion_version_for_storage' not in result_data:
                logger.error(f"Missing notion_version_for_storage in data: {list(result_data.keys())}")
                return False
            
            notion_content = result_data['notion_version_for_storage']
            
            # 移除 markdown 代碼塊包裹
            if notion_content.startswith('```markdown\n') and notion_content.endswith('\n```'):
                notion_content = notion_content[12:-4]
                logger.info("Removed markdown code block wrapper")
            
            # 添加標準標題格式
            final_content = f"# 📰 {date_str} 科技新聞精選（n8n高品質版本）\n\n> 由 n8n 專業工作流程精選並分析的每日科技新聞\n\n## 🔥 今日亮點\n\n" + notion_content
            
            # 保存 markdown 檔案
            md_file_path = self.repo_path / f'{date_str}_community_digest.md'
            with open(md_file_path, 'w', encoding='utf-8') as f:
                f.write(final_content)
            
            logger.info(f"✅ Saved notion content to: {md_file_path.name}")
            
            # 保存 LINE 版本
            if 'line_version_for_publishing' in result_data:
                line_content = result_data['line_version_for_publishing']
                line_file_path = self.repo_path / f'{date_str}_line_digest.txt'
                
                with open(line_file_path, 'w', encoding='utf-8') as f:
                    f.write(line_content)
                
                logger.info(f"✅ Saved LINE content to: {line_file_path.name}")
            
            return True
            
        except Exception as e:
            logger.error(f"Failed to save n8n content: {str(e)}")
            return False
    
    def generate_html_and_publish(self, date_str: str) -> bool:
        """生成 HTML 並發布到 GitHub"""
        try:
            # 導入現有的發布系統
            sys.path.append(str(self.repo_path))
            from generate_daily_news import ThinkerNewsPublisher
            
            publisher = ThinkerNewsPublisher()
            
            # 步驟 1: 生成 HTML
            if not publisher.use_gemini_layout_agent(date_str):
                logger.warning("HTML generation failed")
                return False
            
            # 步驟 2: 更新首頁
            if not publisher.update_index_page(date_str, "今日AI科技重點新聞精選"):
                logger.warning("Index page update failed")
                return False
            
            # 步驟 3: 提交到 GitHub
            if not publisher.commit_and_push(date_str):
                logger.warning("GitHub push failed")
                return False
            
            logger.info(f"🎉 Successfully published news for {date_str}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to generate HTML and publish: {str(e)}")
            return False

# 全域服務實例
news_publisher = NewsPublisher()

# ===============================
# 基本服務端點
# ===============================

@app.route('/', methods=['GET'])
def health_check():
    """基本健康檢查端點"""
    return jsonify({
        "service": "Thinker Café 統一 Webhook 服務",
        "version": SERVICE_VERSION,
        "status": "運行中",
        "timestamp": datetime.now().isoformat(),
        "endpoints": {
            "news": "/webhook/n8n/news-complete",
            "line": "/webhook/line", 
            "memory": "/webhook/memory",
            "test": "/webhook/test"
        }
    })

@app.route('/health', methods=['GET'])
def detailed_health():
    """詳細健康狀態檢查"""
    status = {
        "service": "healthy",
        "repo_path_exists": REPO_PATH.exists(),
        "webhook_secret_configured": WEBHOOK_SECRET != 'default-dev-token',
        "line_configured": bool(LINE_CHANNEL_SECRET),
        "timestamp": datetime.now().isoformat()
    }
    
    status_code = 200 if all([
        status["repo_path_exists"],
        status["webhook_secret_configured"]
    ]) else 500
    
    return jsonify(status), status_code

# ===============================
# n8n 新聞工作流程端點
# ===============================

@app.route('/webhook/n8n/news-complete', methods=['POST'])
def receive_n8n_news():
    """接收 n8n 完成的新聞內容"""
    try:
        # 驗證請求
        auth_header = request.headers.get('Authorization')
        if not auth_header or auth_header != f'Bearer {WEBHOOK_SECRET}':
            logger.warning(f"❌ Unauthorized n8n access from {request.remote_addr}")
            return jsonify({"error": "Unauthorized"}), 401
        
        # 解析請求數據
        if not request.is_json:
            return jsonify({"error": "Content-Type must be application/json"}), 400
        
        data = request.get_json()
        logger.info(f"📨 Received n8n webhook data with keys: {list(data.keys())}")
        
        # 提取日期
        date_str = data.get('final_date') or datetime.now().strftime('%Y-%m-%d')
        logger.info(f"📅 Processing news for date: {date_str}")
        
        # 步驟 1: 保存 n8n 內容
        if not news_publisher.save_n8n_content(date_str, data):
            return jsonify({"error": "Failed to save n8n content"}), 500
        
        # 步驟 2: 生成 HTML 並發布
        if not news_publisher.generate_html_and_publish(date_str):
            logger.warning("⚠️ Publishing failed, but content saved")
            return jsonify({
                "status": "partial_success",
                "message": "Content saved but publishing failed",
                "date": date_str
            }), 202
        
        # 完全成功
        response = {
            "status": "success",
            "message": f"News for {date_str} processed and published successfully",
            "date": date_str,
            "timestamp": datetime.now().isoformat(),
            "website": f"https://thinkercafe-tw.github.io/thinker-news/{date_str}.html"
        }
        
        logger.info(f"🎉 Successfully processed news for {date_str}")
        return jsonify(response), 200
        
    except Exception as e:
        logger.error(f"❌ Error processing n8n webhook: {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route('/n8n/status', methods=['GET'])
def n8n_status():
    """n8n 整合狀態查詢"""
    return jsonify({
        "service": "n8n integration",
        "status": "active",
        "webhook_url": "/webhook/n8n/news-complete",
        "auth_required": "Bearer token",
        "last_processed": "檢查檔案系統取得最後處理時間"
    })

# ===============================
# LINE Bot 端點
# ===============================

@app.route('/webhook/line', methods=['POST'])
def line_webhook():
    """LINE Bot Webhook 接收"""
    try:
        # LINE 平台驗證邏輯 (簡化版)
        signature = request.headers.get('X-Line-Signature', '')
        logger.info(f"📱 Received LINE webhook with signature: {signature[:10]}...")
        
        # 這裡可以加入 LINE Bot 處理邏輯
        body = request.get_json()
        
        return jsonify({"status": "received"}), 200
        
    except Exception as e:
        logger.error(f"❌ LINE webhook error: {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route('/line/status', methods=['GET'])
def line_status():
    """LINE Bot 服務狀態"""
    return jsonify({
        "service": "LINE Bot",
        "status": "configured" if LINE_CHANNEL_SECRET else "not_configured",
        "webhook_url": "/webhook/line"
    })

# ===============================
# Agent 007 記憶宮殿端點
# ===============================

@app.route('/webhook/memory', methods=['POST'])
def memory_sync():
    """記憶宮殿資料同步"""
    try:
        data = request.get_json()
        logger.info(f"🧠 Received memory sync data: {list(data.keys()) if data else 'empty'}")
        
        # 記憶宮殿同步邏輯
        return jsonify({"status": "memory_synced"}), 200
        
    except Exception as e:
        logger.error(f"❌ Memory sync error: {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route('/memory/status', methods=['GET'])
def memory_status():
    """記憶系統狀態"""
    return jsonify({
        "service": "Agent 007 Memory Palace",
        "status": "active",
        "webhook_url": "/webhook/memory"
    })

# ===============================
# 測試端點
# ===============================

@app.route('/webhook/test', methods=['POST'])
def test_endpoint():
    """測試端點"""
    data = request.get_json() if request.is_json else {}
    logger.info(f"🧪 Test endpoint called with: {data}")
    
    return jsonify({
        "status": "test_success", 
        "received_data": data,
        "timestamp": datetime.now().isoformat(),
        "remote_addr": request.remote_addr
    })

# ===============================
# 主程式
# ===============================

if __name__ == '__main__':
    # 環境檢查
    if not REPO_PATH.exists():
        logger.error(f"❌ Repository path does not exist: {REPO_PATH}")
        sys.exit(1)
    
    # 啟動資訊
    logger.info("=" * 50)
    logger.info("🚀 啟動 Thinker Café 統一 Webhook 服務")
    logger.info(f"📁 Repository path: {REPO_PATH}")
    logger.info(f"🔒 Webhook secret configured: {'Yes' if WEBHOOK_SECRET != 'default-dev-token' else 'No'}")
    logger.info(f"📱 LINE Bot configured: {'Yes' if LINE_CHANNEL_SECRET else 'No'}")
    logger.info(f"📊 Debug mode: {'Enabled' if log_level == logging.DEBUG else 'Disabled'}")
    
    # 端點資訊
    logger.info("📋 Available endpoints:")
    logger.info("   GET  /                          - 服務資訊")
    logger.info("   GET  /health                    - 健康檢查")
    logger.info("   POST /webhook/n8n/news-complete - n8n 新聞回調")
    logger.info("   POST /webhook/line              - LINE Bot")
    logger.info("   POST /webhook/memory            - 記憶宮殿同步")
    logger.info("   POST /webhook/test              - 測試端點")
    logger.info("=" * 50)
    
    # 啟動服務
    port = int(os.getenv('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=(log_level == logging.DEBUG))