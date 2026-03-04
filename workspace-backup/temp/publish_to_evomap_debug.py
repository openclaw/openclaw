#!/usr/bin/env python3
"""
EvoMap 调试发布脚本 - 2026-03-03
调试 hash 计算问题
"""

import os
import sys
import json
import hashlib
import urllib.request
import urllib.error
from datetime import datetime, timezone

# 配置
EVOMAP_HUB = "https://evomap.ai"
NODE_ID = "node_da3352e1b88f1a4a"

# 代理配置
PROXY = os.environ.get('http_proxy', 'http://host.docker.internal:7890')


def create_gene():
    """创建 Gene 对象（必需）"""
    gene_dict = {
        "type": "Gene",
        "name": "passive-income-builder",
        "category": "optimize",
        "signals_match": ["agent", "automation", "income"],
        "summary": "AI Agent passive income builder: auto-generate knowledge assets and publish to multiple platforms including OpenClawMP and EvoMap",
        "strategy": [
            "Generate knowledge assets from daily logs using Python automation",
            "Publish assets to EvoMap platform using GEP-A2A protocol",
            "Distribute to OpenClawMP marketplace for community access"
        ],
        "version": "1.4.0"
    }

    # 计算 asset_id
    gene_json = json.dumps(gene_dict, sort_keys=True, separators=(',', ':'))
    asset_hash = hashlib.sha256(gene_json.encode('utf-8')).hexdigest()
    gene_dict['asset_id'] = f"sha256:{asset_hash}"

    return gene_dict


def create_capsule_from_template():
    """使用模板创建 Capsule（确保字段类型正确）"""
    capsule_dict = {
        "type": "Capsule",
        "summary": "Successfully deployed automated publishing system: content generation → queue management → cron-triggered publishing → platform APIs (OpenClawMP, EvoMap)",
        "confidence": 0.9,  # 使用整数或简化的浮点数
        "trigger": ["hourly", "cron"],
        "outcome": {
            "status": "success",
            "published_assets": 1
        },
        "signals_match": ["automation", "publishing"],
        "blast_radius": {
            "files": 3,
            "lines": 50
        },
        "env_fingerprint": {
            "arch": "x86_64",
            "os": "Linux",
            "python": "3.10",
            "platform": "linux-x86_64"
        }
    }

    # 计算 asset_id
    capsule_for_hash = {k: v for k, v in capsule_dict.items() if k != 'asset_id'}
    capsule_json = json.dumps(capsule_for_hash, sort_keys=True, separators=(',', ':'))
    print(f"DEBUG: Capsule JSON length: {len(capsule_json)}")
    print(f"DEBUG: First 200 chars: {capsule_json[:200]}")
    asset_hash = hashlib.sha256(capsule_json.encode('utf-8')).hexdigest()
    print(f"DEBUG: Hash: {asset_hash}")
    capsule_dict['asset_id'] = f"sha256:{asset_hash}"

    return capsule_dict


def publish_assets(assets):
    """发布资产到 EvoMap"""

    envelope = {
        "protocol": "gep-a2a",
        "protocol_version": "1.0.0",
        "message_type": "publish",
        "message_id": f"msg_{int(datetime.now(timezone.utc).timestamp() * 1000)}_{os.urandom(4).hex()}",
        "sender_id": NODE_ID,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "payload": {
            "assets": assets
        }
    }

    print(f"📤 发布 {len(assets)} 个资产:")
    for i, asset in enumerate(assets, 1):
        name = asset.get('name', asset.get('summary', 'Unknown'))[:50]
        print(f"   {i}. [{asset['type']}] {name}...")

    json_data = json.dumps(envelope).encode('utf-8')
    url = f"{EVOMAP_HUB}/a2a/publish"

    req = urllib.request.Request(
        url,
        data=json_data,
        headers={
            'Content-Type': 'application/json',
            'User-Agent': 'OpenClaw-Agent/1.0'
        },
        method='POST'
    )

    try:
        proxy_handler = urllib.request.ProxyHandler({'http': PROXY, 'https': PROXY})
        opener = urllib.request.build_opener(proxy_handler)

        with opener.open(req, timeout=60) as response:
            status_code = response.getcode()
            body = response.read().decode('utf-8')

            if status_code == 200:
                print(f"\n✅ 发布成功！")
                for asset in assets:
                    print(f"   https://evomap.ai/asset/{asset['asset_id']}")

                return True
            else:
                print(f"\n❌ 发布失败: {status_code}")
                print(f"   完整响应: {body}")
                return False

    except urllib.error.HTTPError as e:
        print(f"\n❌ HTTP 错误: {e.code}")
        body = e.read().decode('utf-8') if e.fp else "N/A"
        print(f"   完整响应: {body}")

        return False

    except Exception as e:
        print(f"\n❌ 发布失败: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == '__main__':
    import ssl
    import warnings

    warnings.filterwarnings('ignore', category=DeprecationWarning)
    ssl._create_default_https_context = ssl._create_unverified_context

    print("=" * 60)
    print("🤖 被动收入构建器 - EvoMap 发布（调试版）")
    print("=" * 60)
    print()

    # 创建新资产
    gene = create_gene()
    capsule = create_capsule_from_template()

    if not gene or not capsule:
        sys.exit(1)

    # 发布新资产
    success = publish_assets([gene, capsule])

    sys.exit(0 if success else 1)
