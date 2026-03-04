#!/usr/bin/env python3
"""
AI内容生成平台API服务器
"""

import http.server
import socketserver
import json
import time
import os
from pathlib import Path

class APIHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        """处理GET请求"""
        if self.path == '/api/status':
            self.handle_status()
        elif self.path == '/api/pricing':
            self.handle_pricing()
        else:
            self.send_404()
    
    def do_POST(self):
        """处理POST请求"""
        if self.path == '/api/generate':
            self.handle_generate()
        elif self.path == '/api/subscribe':
            self.handle_subscribe()
        else:
            self.send_404()
    
    def handle_status(self):
        """处理状态请求"""
        status = {
            "status": "active",
            "uptime": time.time(),
            "version": "1.0.0",
            "services": {
                "web": "active",
                "api": "active",
                "payment": "active"
            }
        }
        self.send_json_response(status)
    
    def handle_pricing(self):
        """处理定价请求"""
        pricing = {
            "plans": [
                {
                    "id": "free",
                    "name": "免费版",
                    "price": 0,
                    "currency": "CNY",
                    "features": ["每天3次生成", "基础功能"]
                },
                {
                    "id": "professional", 
                    "name": "专业版",
                    "price": 19,
                    "currency": "CNY",
                    "features": ["无限生成", "SEO优化", "多种格式"]
                },
                {
                    "id": "enterprise",
                    "name": "企业版", 
                    "price": 99,
                    "currency": "CNY",
                    "features": ["专属客服", "高级功能", "团队管理"]
                }
            ]
        }
        self.send_json_response(pricing)
    
    def handle_generate(self):
        """处理生成请求"""
        try:
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))
            
            # 模拟内容生成
            result = {
                "success": True,
                "content": f"这是一篇关于{data.get('topic', 'AI内容生成')}的高质量文章...",
                "word_count": 500,
                "estimated_cost": 5,
                "quality_score": 0.85,
                "generation_time": "3秒"
            }
            
            self.send_json_response(result)
            
        except Exception as e:
            self.send_json_response({"error": str(e)})
    
    def handle_subscribe(self):
        """处理订阅请求"""
        try:
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))
            
            subscription_result = {
                "success": True,
                "subscription_id": f"sub_{int(time.time())}",
                "plan": data.get("plan", "professional"),
                "price": 19,
                "billing_cycle": "monthly",
                "next_billing": time.time() + 2592000
            }
            
            self.send_json_response(subscription_result)
            
        except Exception as e:
            self.send_json_response({"error": str(e)})
    
    def send_json_response(self, data):
        """发送JSON响应"""
        json_data = json.dumps(data, ensure_ascii=False)
        self.send_response(200)
        self.send_header('Content-type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
        self.wfile.write(json_data.encode('utf-8'))
    
    def send_404(self):
        """发送404响应"""
        self.send_response(404)
        self.send_header('Content-type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(b'<html><body><h1>404 - API端点未找到</h1></body></html>')

def start_server():
    """启动服务器"""
    PORT = 8081
    Handler = APIHandler
    
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"API服务器启动在端口 {PORT}")
        print(f"访问地址: http://localhost:{PORT}")
        httpd.serve_forever()

if __name__ == "__main__":
    start_server()
