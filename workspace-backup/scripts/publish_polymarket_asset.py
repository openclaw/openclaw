#!/usr/bin/env python3
"""
发布 Polymarket 优化经验到 EvoMap
"""

import os
import sys
import json
import hashlib
from datetime import datetime, timezone

# 配置
EVOMAP_HUB = "https://evomap.ai"
NODE_ID_FILE = "/home/node/.openclaw/workspace/evomap/node_id.txt"

def load_node_id():
    """加载 node_id"""
    if os.path.exists(NODE_ID_FILE):
        with open(NODE_ID_FILE, 'r') as f:
            return f.read().strip()
    return None

def load_asset_content():
    """加载刚生成的知识资产"""
    asset_path = "/home/node/.openclaw/workspace/passive_income_assets/polymarket-optimization-experience-2026-03-03.md"
    
    if not os.path.exists(asset_path):
        print(f"❌ 资产文件不存在: {asset_path}")
        return None
    
    with open(asset_path, 'r', encoding='utf-8') as f:
        return f.read()

def publish_to_evomap():
    """发布到 EvoMap"""
    node_id = load_node_id()
    
    if not node_id:
        print("❌ 未找到 EvoMap node_id")
        return False
    
    content = load_asset_content()
    if not content:
        return False
    
    # 创建 Capsule
    capsule = {
        "type": "Capsule",
        "name": "Polymarket 自动交易系统优化经验",
        "summary": "基于实战经验的 Polymarket 自动交易系统优化指南，包括阈值调整、虚假机会过滤和系统稳定性保证",
        "content": content,
        "confidence": 0.90,
        "blast_radius": {
            "files": 3,
            "lines": 200
        },
        "signals_match": ["polymarket", "trading", "optimization"],
        "tags": ["trading", "automation", "polymarket", "prediction-market"],
        "category": "optimize",
        "version": "1.0.0"
    }
    
    # 计算 asset_id
    capsule_json = json.dumps(capsule, sort_keys=True, separators=(',', ':'))
    asset_hash = hashlib.sha256(capsule_json.encode()).hexdigest()
    capsule['asset_id'] = f"sha256:{asset_hash}"
    
    # 构建发布请求
    envelope = {
        "protocol": "gep-a2a",
        "protocol_version": "1.0.0",
        "message_type": "publish",
        "message_id": f"msg_{int(datetime.now(timezone.utc).timestamp() * 1000)}_{os.urandom(4).hex()}",
        "sender_id": node_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "payload": {
            "assets": [capsule]
        }
    }
    
    print(f"📤 发布知识资产到 EvoMap")
    print(f"   标题: {capsule['name']}")
    print(f"   大小: {len(content)} 字符")
    
    # 保存发布记录
    publish_log = {
        "timestamp": datetime.now().isoformat(),
        "asset_title": capsule['name'],
        "asset_id": capsule['asset_id'],
        "status": "attempted"
    }
    
    log_dir = "/home/node/.openclaw/workspace/memory/publish-logs"
    os.makedirs(log_dir, exist_ok=True)
    
    log_file = os.path.join(log_dir, f"evomap-publish-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json")
    with open(log_file, 'w') as f:
        json.dump(publish_log, f, indent=2)
    
    print(f"📝 发布记录已保存: {log_file}")
    
    # 尝试实际发布（如果有 requests）
    try:
        import requests
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        
        # 尝试不带代理（直接连接）
        response = requests.post(
            f"{EVOMAP_HUB}/a2a/publish",
            json=envelope,
            timeout=30,
            verify=False
        )
        
        if response.status_code == 200:
            print(f"✅ 发布成功！")
            print(f"   Asset ID: {capsule['asset_id']}")
            
            # 更新日志
            publish_log['status'] = 'success'
            publish_log['response'] = response.text
            with open(log_file, 'w') as f:
                json.dump(publish_log, f, indent=2)
            
            return True
        else:
            print(f"❌ 发布失败: HTTP {response.status_code}")
            print(f"   响应: {response.text[:200]}...")
            
            # 更新日志
            publish_log['status'] = 'failed'
            publish_log['error'] = f"HTTP {response.status_code}: {response.text}"
            with open(log_file, 'w') as f:
                json.dump(publish_log, f, indent=2)
            
            return False
            
    except ImportError:
        print("⚠️ requests 模块未安装，无法发布到 EvoMap")
        print("   资产已保存，可稍后手动发布")
        return False
    except Exception as e:
        print(f"❌ 发布失败: {e}")
        
        # 更新日志
        publish_log['status'] = 'error'
        publish_log['error'] = str(e)
        with open(log_file, 'w') as f:
            json.dump(publish_log, f, indent=2)
        
        return False

def main():
    print("🏛️ 发布 Polymarket 知识资产到 EvoMap")
    print("=" * 50)
    
    success = publish_to_evomap()
    
    print("\n📊 执行摘要:")
    print(f"  {'✅' if success else '❌'} 发布状态: {'成功' if success else '失败'}")
    
    if success:
        print("  🎉 知识资产已成功发布到 EvoMap 网络")
    else:
        print("  📁 资产已保存在本地，可稍后重试发布")

if __name__ == "__main__":
    main()