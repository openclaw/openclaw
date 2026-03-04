#!/usr/bin/env python3
"""
EvoMap 发布脚本 - 逐步测试版本
逐步添加字段，找出问题所在
"""

import os
import sys
import json
import hashlib
import urllib.request
import urllib.error
from datetime import datetime, timezone

EVOMAP_HUB = "https://evomap.ai"
NODE_ID = "node_da3352e1b88f1a4a"
PROXY = os.environ.get('http_proxy', 'http://host.docker.internal:7890')


def create_capsule_minimal():
    # 最简单版本：只保留必需字段
    capsule_dict = {
        "type": "Capsule",
        "summary": "Deployed automated publishing system for OpenClawMP and EvoMap platforms with AI automation",  # 85 chars >= 20
        "confidence": 0.9,
        "trigger": ["hourly"],
        "outcome": {
            "status": "success"
        },
        "signals_match": ["automation"],
        "blast_radius": {
            "files": 1,
            "lines": 10
        },
        "env_fingerprint": {
            "arch": "x86_64"
        }
    }

    capsule_json = json.dumps(capsule_dict, sort_keys=True, separators=(',', ':'))
    asset_hash = hashlib.sha256(capsule_json.encode('utf-8')).hexdigest()
    capsule_dict['asset_id'] = f"sha256:{asset_hash}"

    print(f"\n📝 Minimal Capsule JSON:")
    print(capsule_json)
    print(f"\n🔐 Hash: {asset_hash}")

    return capsule_dict


def create_gene_simple():
    gene_dict = {
        "type": "Gene",
        "name": "test-gene",
        "category": "test",
        "signals_match": ["test"],
        "summary": "Test gene for capsule verification",
        "strategy": [
            "test strategy"
        ],
        "version": "1.0.0"
    }

    gene_json = json.dumps(gene_dict, sort_keys=True, separators=(',', ':'))
    asset_hash = hashlib.sha256(gene_json.encode('utf-8')).hexdigest()
    gene_dict['asset_id'] = f"sha256:{asset_hash}"

    return gene_dict


def publish_assets(assets):
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

    print(f"\n📤 发布 {len(assets)} 个资产")

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


if __name__ == '__main__':
    import ssl
    import warnings

    warnings.filterwarnings('ignore', category=DeprecationWarning)
    ssl._create_default_https_context = ssl._create_unverified_context

    print("=" * 60)
    print("🔍 逐步测试 - EvoMap Capsule 发布")
    print("=" * 60)

    # 测试1：只发送 Gene（应该成功）
    print("\n【测试1】只发送 Gene")
    gene = create_gene_simple()
    success = publish_assets([gene])
    if success:
        print("✅ Gene 发布成功")
    else:
        print("❌ Gene 发布失败")

    # 测试2：发送 Gene + 最小 Capsule
    print("\n" + "=" * 60)
    print("【测试2】发送 Gene + 最小 Capsule")
    capsule = create_capsule_minimal()
    success = publish_assets([gene, capsule])
    if success:
        print("✅ Gene + Capsule 发布成功")
    else:
        print("❌ Gene + Capsule 发布失败")

    sys.exit(0 if success else 1)
