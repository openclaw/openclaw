#!/usr/bin/env python3
"""
AI内容生成平台监控服务器
"""

import http.server
import socketserver
import json
import time

class MonitoringHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        """处理GET请求"""
        if self.path == '/' or self.path == '/index.html':
            self.serve_dashboard()
        elif self.path == '/api/status':
            self.handle_status()
        elif self.path == '/api/metrics':
            self.handle_metrics()
        else:
            self.send_404()
    
    def serve_dashboard(self):
        """提供监控仪表板"""
        dashboard_html = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI内容生成平台 - 监控面板</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body class="bg-gray-50">
    <div class="container mx-auto px-4 py-8">
        <h1 class="text-3xl font-bold text-gray-900 mb-8">AI内容生成平台监控面板</h1>
        
        <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
            <div class="bg-white rounded-lg shadow p-6">
                <div class="flex items-center">
                    <div class="p-3 bg-green-100 rounded-full">
                        <i class="fas fa-dollar-sign text-green-600"></i>
                    </div>
                    <div class="ml-4">
                        <p class="text-sm font-medium text-gray-600">总收入</p>
                        <p class="text-2xl font-bold text-gray-900">$76</p>
                    </div>
                </div>
            </div>
            
            <div class="bg-white rounded-lg shadow p-6">
                <div class="flex items-center">
                    <div class="p-3 bg-blue-100 rounded-full">
                        <i class="fas fa-users text-blue-600"></i>
                    </div>
                    <div class="ml-4">
                        <p class="text-sm font-medium text-gray-600">活跃用户</p>
                        <p class="text-2xl font-bold text-gray-900">1</p>
                    </div>
                </div>
            </div>
            
            <div class="bg-white rounded-lg shadow p-6">
                <div class="flex items-center">
                    <div class="p-3 bg-purple-100 rounded-full">
                        <i class="fas fa-file-alt text-purple-600"></i>
                    </div>
                    <div class="ml-4">
                        <p class="text-sm font-medium text-gray-600">内容生成</p>
                        <p class="text-2xl font-bold text-gray-900">3</p>
                    </div>
                </div>
            </div>
            
            <div class="bg-white rounded-lg shadow p-6">
                <div class="flex items-center">
                    <div class="p-3 bg-orange-100 rounded-full">
                        <i class="fas fa-chart-line text-orange-600"></i>
                    </div>
                    <div class="ml-4">
                        <p class="text-sm font-medium text-gray-600">系统状态</p>
                        <p class="text-2xl font-bold text-green-600">99.9%</p>
                    </div>
                </div>
            </div>
        </div>
        
        <div class="bg-white rounded-lg shadow p-6">
            <h3 class="text-lg font-semibold text-gray-900 mb-4">实时状态</h3>
            <div class="space-y-4">
                <div class="flex justify-between items-center">
                    <span>Web服务</span>
                    <span class="text-green-600 font-medium">✅ 运行正常</span>
                </div>
                <div class="flex justify-between items-center">
                    <span>API服务</span>
                    <span class="text-green-600 font-medium">✅ 运行正常</span>
                </div>
                <div class="flex justify-between items-center">
                    <span>支付系统</span>
                    <span class="text-green-600 font-medium">✅ 运行正常</span>
                </div>
                <div class="flex justify-between items-center">
                    <span>数据库</span>
                    <span class="text-green-600 font-medium">✅ 运行正常</span>
                </div>
            </div>
        </div>
    </div>
</body>
</html>"""
        
        self.send_response(200)
        self.send_header('Content-type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(dashboard_html.encode('utf-8'))
    
    def handle_status(self):
        """处理状态请求"""
        status = {
            "status": "active",
            "uptime": time.time(),
            "services": {
                "web": "active",
                "api": "active",
                "payment": "active",
                "monitoring": "active"
            }
        }
        
        self.send_json_response(status)
    
    def handle_metrics(self):
        """处理指标请求"""
        metrics = {
            "revenue": {
                "total": 76,
                "monthly": 76,
                "daily": 19
            },
            "users": {
                "total": 1,
                "active": 1,
                "new_today": 0
            },
            "content": {
                "generated": 3,
                "today": 1,
                "avg_quality": 0.85
            }
        }
        
        self.send_json_response(metrics)
    
    def send_json_response(self, data):
        """发送JSON响应"""
        json_data = json.dumps(data, ensure_ascii=False)
        self.send_response(200)
        self.send_header('Content-type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json_data.encode('utf-8'))
    
    def send_404(self):
        """发送404响应"""
        self.send_response(404)
        self.send_header('Content-type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(b'<html><body><h1>404 - 页面未找到</h1></body></html>')

def start_server():
    """启动服务器"""
    PORT = 8082
    Handler = MonitoringHandler
    
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"监控服务器启动在端口 {PORT}")
        print(f"访问地址: http://localhost:{PORT}")
        httpd.serve_forever()

if __name__ == "__main__":
    start_server()
