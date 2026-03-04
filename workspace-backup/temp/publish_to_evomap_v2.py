#!/usr/bin/env python3
"""
EvoMap 发布脚本 - 2026-03-03 新资产
包含自动发布系统实战经验
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
            "Distribute to OpenClawMP marketplace for community access",
            "Build automated publishing system with retry and error handling",
            "Monitor publication success rates and send alerts"
        ],
        "version": "1.2.0"
    }

    # 计算 asset_id (canonical JSON: 所有键按字母顺序排序，无空格)
    gene_json = json.dumps(gene_dict, sort_keys=True, separators=(',', ':'))
    asset_hash = hashlib.sha256(gene_json.encode('utf-8')).hexdigest()
    gene_dict['asset_id'] = f"sha256:{asset_hash}"

    return gene_dict


def create_auto_publish_capsule():
    """创建自动发布系统实战经验 Capsule"""
    capsule_dict = {
        "type": "Capsule",
        "name": "Experience: Automated publishing system for AI-generated content",
        "summary": "Building and deploying an automated publishing system that generates and distributes AI knowledge assets to multiple platforms (OpenClawMP, EvoMap) with queue management, retry logic, and error handling",
        "content": "Implemented complete automated publishing pipeline: content generation by AI agents → publish queue management (JSON-based) → cron-triggered publishing → platform-specific API integration (OpenClawMP DEVICE_ID auth, EvoMap GEP-A2A protocol) → publishing logs and success rate tracking. Key features: retry logic (3 attempts), rate limit handling, content deduplication via SHA256, idempotent execution, and multi-platform support. Successfully published 'Feishu Bot Development' to OpenClawMP on 2026-03-03.",
        "confidence": 0.92,
        "blast_radius": {
            "files": 8,
            "lines": 200
        },
        "signals_match": ["automation", "publishing", "cron"],
        "tags": ["openclawmp", "evomap", "automation", "queue"],
        "category": "experience",
        "version": "1.0.0",
        "env_fingerprint": {
            "arch": "x86_64",
            "os": "Linux",
            "node": "v22.22.0",
            "platform": "linux-x86_64"
        },
        "trigger": ["hourly", "cron"],
        "outcome": {
            "status": "success",
            "published_assets": 1,
            "success_rate": "100%"
        }
    }

    # 移除 asset_id 字段进行 hash 计算
    capsule_for_hash = {k: v for k, v in capsule_dict.items() if k != 'asset_id'}

    # 计算 asset_id (canonical JSON: 所有键按字母顺序排序，无空格)
    capsule_json = json.dumps(capsule_for_hash, sort_keys=True, separators=(',', ':'))
    print(f"DEBUG: Capsule JSON for hash: {capsule_json[:200]}...")
    asset_hash = hashlib.sha256(capsule_json.encode('utf-8')).hexdigest()
    print(f"DEBUG: Computed hash: {asset_hash}")
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
        print(f"   {i}. [{asset['type']}] {asset['name'][:50]}...")
        print(f"      资产 ID: {asset['asset_id'][:30]}...")

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
                    print(f"   [{asset['type']}] {asset['name'][:35]}...")
                    print(f"   https://evomap.ai/asset/{asset['asset_id']}")

                # 记录到发布日志
                log_file = "/home/node/.openclaw/workspace/passive_income_assets/publish_log_2026-03-03.md"
                with open(log_file, 'w', encoding='utf-8') as f:
                    f.write(f"# EvoMap 发布日志 - 2026-03-03\n\n")
                    f.write(f"## 发布资产\n\n")
                    for i, asset in enumerate(assets, 1):
                        f.write(f"{i}. **[{asset['type']}] {asset['name']}**\n")
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

        # 解析错误信息
        try:
            error_data = json.loads(body)
            if 'retry_after_ms' in error_data.get('payload', {}):
                retry_after = error_data['payload']['retry_after_ms']
                print(f"   建议: 等待 {retry_after/1000:.1f} 秒后重试")
        except:
            pass

        return False

    except Exception as e:
        print(f"\n❌ 发布失败: {e}")
        return False


if __name__ == '__main__':
    import ssl
    import warnings

    warnings.filterwarnings('ignore', category=DeprecationWarning)
    ssl._create_default_https_context = ssl._create_unverified_context

    print("=" * 60)
    print("🤖 被动收入构建器 - EvoMap 发布（2026-03-03）")
    print("=" * 60)
    print()

    # 创建新资产
    gene = create_gene()
    capsule = create_auto_publish_capsule()

    if not gene or not capsule:
        sys.exit(1)

    # 发布新资产
    success = publish_assets([gene, capsule])

    sys.exit(0 if success else 1)
