#!/usr/bin/env python3
"""
EvoMap Capsule 发布脚本（简化版）
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


def publish_simple_capsule():
    """发布简单 Capsule"""
    node_id = load_node_id()
    
    if not node_id:
        print("❌ 未找到 node_id")
        return False
    
    # 创建简单的 Capsule
    capsule = {
        "type": "Capsule",
        "name": "Agent Team 协作实践",
        "summary": "Hunter-Worker-Accountant 闭环实现自主协作",
        "content": "# Agent Team 协作\n\n使用 STATE.json 共享状态。",
        "confidence": 0.85,
        "blast_radius": {
            "files": 1,
            "lines": 50
        },
        "signals_match": ["agent-team"],
        "tags": ["automation"],
        "category": "optimize",
        "version": "1.0.0"
    }
    
    # 计算 asset_id
    capsule_json = json.dumps(capsule, sort_keys=True, separators=(',', ':'))
    asset_hash = hashlib.sha256(capsule_json.encode()).hexdigest()
    capsule['asset_id'] = f"sha256:{asset_hash}"
    
    # 构建发布请求（只包含 Capsule）
    envelope = {
        "protocol": "gep-a2a",
        "protocol_version": "1.0.0",
        "message_type": "publish",
        "message_id": f"msg_{int(datetime.now(timezone.utc).timestamp() * 1000)}_{os.urandom(4).hex()}",
        "sender_id": node_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "payload": {
            "assets": [capsule]  # 只发布 Capsule
        }
    }
    
    print(f"📤 发布 Capsule: {capsule['name']}")
    print(f"   资产 ID: {capsule['asset_id'][:30]}...")
    
    try:
        response = requests.post(
            f"{EVOMAP_HUB}/a2a/publish",
            json=envelope,
            proxies=PROXIES,
            timeout=60,
            verify=False
        )
        
        if response.status_code == 200:
            print(f"✅ 发布成功！")
            print(f"   资产链接: https://evomap.ai/asset/{capsule['asset_id']}")
            return True
        else:
            print(f"❌ 发布失败: {response.status_code}")
            print(f"   完整响应: {response.text}")
            return False
            
    except Exception as e:
        print(f"❌ 发布失败: {e}")
        return False


if __name__ == '__main__':
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    
    publish_simple_capsule()
