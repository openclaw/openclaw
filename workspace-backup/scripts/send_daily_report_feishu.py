#!/usr/bin/env python3
"""
发送每日早报到飞书
读取 /tmp/daily_report.txt 并发送到飞书
"""

import os
import sys
from pathlib import Path

# 添加 Python 路径
sys.path.insert(0, '/home/node/.local/lib/python3.11/site-packages')

try:
    import requests
except ImportError:
    print("❌ 缺少 requests 库，请安装: pip install requests")
    sys.exit(1)


def send_feishu_message(message: str):
    """发送飞书消息"""
    webhook_url = os.getenv('FEISHU_WEBHOOK_URL')
    
    if not webhook_url:
        print("⚠️  未配置飞书 Webhook URL")
        print("   请设置环境变量: FEISHU_WEBHOOK_URL")
        return False
    
    try:
        # 使用富文本格式发送
        payload = {
            "msg_type": "post",
            "content": {
                "post": {
                    "zh_cn": {
                        "title": "📅 每日早报",
                        "content": [[
                            {
                                "tag": "text",
                                "text": message
                            }
                        ]]
                    }
                }
            }
        }
        
        response = requests.post(webhook_url, json=payload, timeout=10)
        
        if response.status_code == 200:
            result = response.json()
            if result.get("StatusCode") == 0 or result.get("code") == 0:
                print("✅ 飞书早报发送成功")
                return True
            else:
                print(f"❌ 飞书早报发送失败: {result}")
                return False
        else:
            print(f"❌ 飞书早报发送失败: HTTP {response.status_code}")
            print(f"   响应: {response.text}")
            return False
    
    except Exception as e:
        print(f"❌ 发送飞书消息失败: {e}")
        return False


def main():
    """主函数"""
    # 读取早报内容
    report_file = Path("/tmp/daily_report.txt")
    
    if not report_file.exists():
        print("❌ 早报文件不存在: /tmp/daily_report.txt")
        print("   请先运行 generate_daily_report.py 生成早报")
        return 1
    
    message = report_file.read_text(encoding="utf-8")
    
    # 发送到飞书
    success = send_feishu_message(message)
    
    return 0 if success else 1


if __name__ == "__main__":
    exit(main())
