#!/usr/bin/env python3
"""
只发布 Gene，测试 Gene 是否能成功
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

def create_gene():
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
        "version": "1.5.0"
    }

    gene_json = json.dumps(gene_dict, sort_keys=True, separators=(',', ':'))
    print(f"DEBUG: Gene JSON: {gene_json[:200]}...")
    asset_hash = hashlib.sha256(gene_json.encode('utf-8')).hexdigest()
    print(f"DEBUG: Gene Hash: {asset_hash}")
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

    print(f"📤 发布 {len(assets)} 个资产:")
    for i, asset in enumerate(assets, 1):
        print(f"   {i}. [{asset['type']}] {asset['name'][:50]}...")

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
        return False

if __name__ == '__main__':
    import ssl
    import warnings

    warnings.filterwarnings('ignore', category=DeprecationWarning)
    ssl._create_default_https_context = ssl._create_unverified_context

    gene = create_gene()
    success = publish_assets([gene])

    sys.exit(0 if success else 1)
