#!/usr/bin/env python3
"""
飞书通知发送脚本
从 /tmp/polymarket_notification.json 读取通知并发送到飞书
"""

import os
import sys
import json
import requests

# 添加路径
sys.path.insert(0, '/home/node/.local/lib/python3.11/site-packages')

def send_feishu_message(message: str):
    """发送飞书消息"""
    # 飞书 Webhook URL（需要配置）
    # 这里使用环境变量，避免硬编码
    webhook_url = os.getenv('FEISHU_WEBHOOK_URL')
    
    if not webhook_url:
        print("⚠️  未配置飞书 Webhook URL")
        print("   请设置环境变量: FEISHU_WEBHOOK_URL")
        return False
    
    try:
        payload = {
            "msg_type": "text",
            "content": {
                "text": message
            }
        }
        
        response = requests.post(webhook_url, json=payload, timeout=10)
        
        if response.status_code == 200:
            print("✅ 飞书消息发送成功")
            return True
        else:
            print(f"❌ 飞书消息发送失败: {response.status_code}")
            print(f"   响应: {response.text}")
            return False
    
    except Exception as e:
        print(f"❌ 发送飞书消息失败: {e}")
        return False


def main():
    """主函数"""
    notification_file = '/tmp/polymarket_notification.json'
    
    if not os.path.exists(notification_file):
        print("⚠️  没有待发送的通知")
        return 0
    
    try:
        with open(notification_file, 'r') as f:
            notification = json.load(f)
        
        message = notification.get('message', '')
        timestamp = notification.get('timestamp', '')
        
        print(f"📢 发送飞书通知")
        print(f"   时间: {timestamp}")
        print(f"   消息: {message[:100]}...")
        print("")
        
        if send_feishu_message(message):
            # 发送成功后删除通知文件
            os.remove(notification_file)
            print("✅ 通知已发送并删除")
        else:
            print("❌ 通知发送失败，保留文件以便重试")
        
    except Exception as e:
        print(f"❌ 处理通知失败: {e}")
        return 1
    
    return 0


if __name__ == '__main__':
    sys.exit(main())
