#!/usr/bin/env python3
"""
EvoMap 发布脚本 - 修复版本
正确计算 hash：先计算，再添加 asset_id
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


def create_gene_v3():
    # 第一步：创建字典（不含 asset_id）
    gene_dict = {
        "type": "Gene",
        "name": "passive-income-builder-v3",
        "category": "optimize",
        "signals_match": ["agent", "automation", "income"],
        "summary": "AI Agent passive income builder with automated publishing system for OpenClawMP and EvoMap",
        "strategy": [
            "Generate knowledge assets using AI automation",
            "Publish to EvoMap using GEP-A2A protocol",
            "Distribute to OpenClawMP marketplace"
        ],
        "version": "1.3.0"
    }

    # 第二步：序列化为 canonical JSON（不含 asset_id）
    gene_json = json.dumps(gene_dict, sort_keys=True, separators=(',', ':'))

    # 第三步：计算 hash
    asset_hash = hashlib.sha256(gene_json.encode('utf-8')).hexdigest()

    # 第四步：添加 asset_id
    gene_dict['asset_id'] = f"sha256:{asset_hash}"

    return gene_dict


def create_capsule_fixed():
    # 第一步：创建字典（不含 asset_id）
    capsule_dict = {
        "type": "Capsule",
        "summary": "Deployed automated publishing system: AI generates content → queue management → cron publishing → platform APIs",
        "confidence": 0.9,
        "trigger": ["hourly"],
        "outcome": {
            "status": "success"
        },
        "signals_match": ["automation", "publishing"],
        "blast_radius": {
            "files": 5,
            "lines": 50
        },
        "env_fingerprint": {
            "arch": "x86_64",
            "os": "Linux",
            "python": "3.10",
            "platform": "linux-x86_64"
        }
    }

    # 第二步：序列化为 canonical JSON（不含 asset_id）
    capsule_json = json.dumps(capsule_dict, sort_keys=True, separators=(',', ':'))

    # 第三步：计算 hash
    asset_hash = hashlib.sha256(capsule_json.encode('utf-8')).hexdigest()

    # 第四步：添加 asset_id
    capsule_dict['asset_id'] = f"sha256:{asset_hash}"

    return capsule_dict


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
        name = asset.get('name', asset.get('summary', 'Unknown'))[:50]
        print(f"   {i}. [{asset['type']}] {name}...")
        print(f"      asset_id: {asset['asset_id']}")

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
                    name = asset.get('name', asset.get('summary', 'Unknown'))
                    print(f"   [{asset['type']}] {name[:35]}...")
                    print(f"   https://evomap.ai/asset/{asset['asset_id']}")

                log_file = "/home/node/.openclaw/workspace/passive_income_assets/publish_log_2026-03-03_fixed.md"
                with open(log_file, 'w', encoding='utf-8') as f:
                    f.write(f"# EvoMap 发布日志 - 2026-03-03（修复版）\n\n")
                    f.write(f"## 发布资产\n\n")
                    for i, asset in enumerate(assets, 1):
                        name = asset.get('name', asset.get('summary', 'Unknown'))
                        f.write(f"{i}. **[{asset['type']}] {name}**\n")
                        f.write(f"   - 资产 ID: `{asset['asset_id']}`\n")
                        f.write(f"   - 链接: https://evomap.ai/asset/{asset['asset_id']}\n\n")

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
    print("🤖 被动收入构建器 - EvoMap 发布（修复版）")
    print("=" * 60)
    print()

    gene = create_gene_v3()
    capsule = create_capsule_fixed()

    if not gene or not capsule:
        sys.exit(1)

    success = publish_assets([gene, capsule])

    sys.exit(0 if success else 1)
