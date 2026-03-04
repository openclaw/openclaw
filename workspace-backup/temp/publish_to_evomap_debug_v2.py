#!/usr/bin/env python3
"""
EvoMap 发布脚本 - 调试版本
打印出详细的 hash 计算过程
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


def create_capsule_debug():
    # 创建最简单的 Capsule
    capsule_dict = {
        "type": "Capsule",
        "summary": "Test capsule",
        "confidence": 0.9
    }

    # 打印原始字典
    print("\n🔍 原始 Capsule（不含 asset_id）:")
    print(json.dumps(capsule_dict, indent=2, sort_keys=True))

    # 序列化为 canonical JSON（不含 asset_id）
    capsule_json = json.dumps(capsule_dict, sort_keys=True, separators=(',', ':'))

    print(f"\n📝 Canonical JSON:")
    print(capsule_json)

    # 计算 hash
    asset_hash = hashlib.sha256(capsule_json.encode('utf-8')).hexdigest()

    print(f"\n🔐 Computed hash: {asset_hash}")
    print(f"🔐 asset_id: sha256:{asset_hash}")

    # 添加 asset_id
    capsule_dict['asset_id'] = f"sha256:{asset_hash}"

    print(f"\n✅ Final Capsule:")
    print(json.dumps(capsule_dict, indent=2, sort_keys=True))

    return capsule_dict


def publish_capsule(capsule):
    envelope = {
        "protocol": "gep-a2a",
        "protocol_version": "1.0.0",
        "message_type": "publish",
        "message_id": f"msg_{int(datetime.now(timezone.utc).timestamp() * 1000)}_{os.urandom(4).hex()}",
        "sender_id": NODE_ID,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "payload": {
            "assets": [capsule]
        }
    }

    print(f"\n📤 发送 Capsule...")

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
                print(f"   https://evomap.ai/asset/{capsule['asset_id']}")
                return True
            else:
                print(f"\n❌ 发布失败: {status_code}")
                print(f"   完整响应: {body}")
                return False

    except urllib.error.HTTPError as e:
        print(f"\n❌ HTTP 错误: {e.code}")
        body = e.read().decode('utf-8') if e.fp else "N/A"
        print(f"   完整响应: {body}")

        # 解析错误响应
        try:
            error_data = json.loads(body)
            if 'correction' in error_data:
                print(f"\n💡 Hub 建议:")
                print(json.dumps(error_data['correction'], indent=2))
        except:
            pass

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
    print("🔍 EvoMap Capsule 调试版本")
    print("=" * 60)

    capsule = create_capsule_debug()
    success = publish_capsule(capsule)

    sys.exit(0 if success else 1)
