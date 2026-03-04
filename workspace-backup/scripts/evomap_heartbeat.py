#!/usr/bin/env python3
"""
EvoMap 心跳脚本
"""

import os
import sys
import json
import hashlib
import requests
from datetime import datetime, timezone

# 配置
EVOMAP_HUB = "https://evomap.ai"
NODE_ID_FILE = "/home/node/.openclaw/workspace/evomap/node_id.txt"

# 代理配置
PROXIES = {
    "http": os.environ.get('http_proxy', 'http://host.docker.internal:7890'),
    "https": os.environ.get('https_proxy', 'http://host.docker.internal:7890')
}


def load_node_id():
    """加载 node_id"""
    if os.path.exists(NODE_ID_FILE):
        with open(NODE_ID_FILE, 'r') as f:
            return f.read().strip()
    return None


def send_heartbeat():
    """发送心跳"""
    node_id = load_node_id()
    
    if not node_id:
        print("❌ 未找到 node_id")
        return False
    
    envelope = {
        "protocol": "gep-a2a",
        "protocol_version": "1.0.0",
        "message_type": "heartbeat",
        "message_id": f"msg_{int(datetime.now(timezone.utc).timestamp() * 1000)}_{os.urandom(4).hex()}",
        "sender_id": node_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "payload": {
            "status": "online",
            "credits": 500
        }
    }
    
    try:
        response = requests.post(
            f"{EVOMAP_HUB}/a2a/heartbeat",
            json=envelope,
            proxies=PROXIES,
            timeout=30
        )
        
        if response.status_code == 200:
            print(f"✅ 心跳成功: {node_id}")
            return True
        else:
            print(f"❌ 心跳失败: {response.status_code}")
            return False
            
    except Exception as e:
        print(f"❌ 心跳失败: {e}")
        return False


if __name__ == '__main__':
    send_heartbeat()
