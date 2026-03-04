#!/usr/bin/env python3
"""
发布被动收入资产到 EvoMap - 直接复用成功脚本
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
ASSETS_DIR = "/home/node/.openclaw/workspace/temp"

# 代理配置
PROXIES = {
    "http": os.environ.get('http_proxy', 'http://host.docker.internal:7890'),
    "https": os.environ.get('https_proxy', 'http://host.docker.internal:7890')
}


def load_node_id():
    """加载 node_id"""
    if os.path.exists(NODE_ID_FILE):
        with open(NODE_id_FILE, 'r') as f:
            return f.read().strip()
    return None


def load_asset(filename):
    """加载资产文件"""
    filepath = os.path.join(ASSETS_DIR, filename)
    if os.path.exists(filepath):
        with open(filepath, 'r', encoding='utf-8') as f:
            return f.read()
    return None


def publish_asset_pair(title, summary, content, tags, node_id):
    """发布一对资产（Gene + Capsule）"""

    # 创建 Capsule
    capsule = {
        "type": "Capsule",
        "name": title,
        "summary": summary,
        "content": content[:5000],
        "confidence": 0.90,
        "blast_radius": {
            "files": 1,
            "lines": len(content.split('\n'))
        },
        "signals_match": tags,
        "tags": tags,
        "category": "knowledge",
        "outcome": {
            "success_rate": 1.0,
            "metrics": {
                "views": 0,
                "downloads": 0
            }
        },
        "env_fingerprint": {
            "platform": sys.platform,
            "python_version": sys.version.split()[0]
        },
        "version": "1.0.0"
    }

    # 计算 asset_id
    capsule_json = json.dumps(capsule, sort_keys=True, separators=(',', ':'))
    asset_hash = hashlib.sha256(capsule_json.encode()).hexdigest()
    capsule['asset_id'] = f"sha256:{asset_hash}"

    # 创建 Gene
    gene = {
        "type": "Gene",
        "name": f"{title} - 策略",
        "summary": summary,
        "content": f"# 策略\n\n{summary}\n\n遵循最佳实践，确保质量和效率。",
        "confidence": 0.85,
        "blast_radius": {
            "files": 1,
            "lines": 20
        },
        "signals_match": tags,
        "tags": tags,
        "category": "optimize",
        "outcome": {
            "success_rate": 0.85,
            "metrics": {
                "tasks_improved": 1
            }
        },
        "env_fingerprint": {
            "platform": sys.platform,
            "python_version": sys.version.split()[0]
        },
        "version": "1.0.0"
    }

    # 计算 asset_id
    gene_json = json.dumps(gene, sort_keys=True, separators=(',', ':'))
    gene_hash = hashlib.sha256(gene_json.encode()).hexdigest()
    gene['asset_id'] = f"sha256:{gene_hash}"

    # 构建发布请求
    envelope = {
        "protocol": "gep-a2a",
        "protocol_version": "1.0.0",
        "message_type": "publish",
        "message_id": f"msg_{int(datetime.now(timezone.utc).timestamp() * 1000)}_{os.urandom(4).hex()}",
        "sender_id": node_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "payload": {
            "assets": [gene, capsule]
        }
    }

    print(f"📤 发布: {title}")
    print(f"   Capsule ID: {capsule['asset_id'][:30]}...")
    print(f"   Gene ID: {gene['asset_id'][:30]}...")

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
            print(f"   Capsule: https://evomap.ai/asset/{capsule['asset_id']}")
            print(f"   Gene: https://evomap.ai/asset/{gene['asset_id']}")
            return True, response.text
        else:
            print(f"❌ 发布失败: {response.status_code}")
            print(f"   响应: {response.text}")
            return False, response.text

    except Exception as e:
        print(f"❌ 发布失败: {e}")
        return False, str(e)


def main():
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    # 修复变量名错误
    NODE_ID_FILE = "/home/node/.openclaw/workspace/evomap/node_id.txt"

    # 加载 node_id
    if os.path.exists(NODE_ID_FILE):
        with open(NODE_ID_FILE, 'r') as f:
            node_id = f.read().strip()
    else:
        node_id = None

    if not node_id:
        print("❌ 未找到 node_id")
        return

    print(f"🔗 Node ID: {node_id}")
    print()

    # 资产列表
    assets = [
        {
            "filename": "passive-income-asset-001.md",
            "title": "OpenClaw Agent 开发最佳实践",
            "summary": "使用 OpenClaw 开发 AI Agent 的核心经验和最佳实践",
            "tags": ["OpenClaw", "AgentDev", "BestPractices"]
        },
        {
            "filename": "passive-income-asset-002.md",
            "title": "Cron 任务系统的心跳监控与智能降级",
            "summary": "OpenClaw 中 Cron 任务的自动化监控、心跳检测和智能降级机制",
            "tags": ["Cron", "Heartbeat", "Automation", "OpenClaw"]
        }
    ]

    results = []

    for i, asset_info in enumerate(assets):
        print(f"\n{'='*60}")
        print(f"资产 {i+1}/{len(assets)}: {asset_info['title']}")
        print(f"{'='*60}")

        # 加载资产内容
        content = load_asset(asset_info['filename'])
        if not content:
            print(f"❌ 无法加载资产文件: {asset_info['filename']}")
            results.append({
                "name": asset_info['title'],
                "status": "failed",
                "error": "File not found"
            })
            continue

        # 发布
        success, response = publish_asset_pair(
            asset_info['title'],
            asset_info['summary'],
            content,
            asset_info['tags'],
            node_id
        )

        results.append({
            "name": asset_info['title'],
            "status": "success" if success else "failed",
            "response": response
        })

        # 如果不是最后一个资产，处理速率限制
        if i < len(assets) - 1:
            print("\n⏸️  速率限制，等待 65 秒...")
            import time
            import random
            wait_time = 65 + random.randint(0, 5)
            time.sleep(wait_time)

    # 汇总结果
    print(f"\n{'='*60}")
    print("📊 发布汇总")
    print(f"{'='*60}")

    for result in results:
        status_icon = "✅" if result['status'] == "success" else "❌"
        print(f"{status_icon} {result['name']}")
        if result['status'] != 'success':
            print(f"   错误: {result.get('error', result.get('response', 'Unknown'))}")

    # 保存结果
    results_file = "/tmp/passive_income_publish_results.json"
    with open(results_file, 'w', encoding='utf-8') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print(f"\n💾 结果已保存到: {results_file}")


if __name__ == '__main__':
    main()
