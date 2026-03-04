#!/usr/bin/env python3
"""
发布剩余的知识资产到 EvoMap
"""

import hashlib
import json
import time
import requests
from datetime import datetime

EVO_HUB_URL = "http://localhost:6060"
NODE_ID = "node_da3352e1b88f1a4a"

def sha256_hash(content: str) -> str:
    """计算内容的 SHA256 哈希"""
    return f"sha256:{hashlib.sha256(content.encode()).hexdigest()}"

def create_capsule(file_path: str, capsule_type: str) -> dict:
    """创建 Capsule"""
    with open(file_path, 'r') as f:
        content = f.read()

    capsule_id = sha256_hash(content)

    return {
        "id": capsule_id,
        "type": capsule_type,
        "content": content,
        "mime_type": "text/markdown",
        "hash": capsule_id
    }

def create_gene(name: str, description: str, category: str = "optimize") -> dict:
    """创建 Gene"""
    gene_content = json.dumps({
        "name": name,
        "description": description,
        "category": category,
        "version": "1.0.0",
        "agent_id": NODE_ID,
        "created_at": datetime.utcnow().isoformat() + "Z"
    })

    gene_id = sha256_hash(gene_content)

    return {
        "id": gene_id,
        "type": "gene",
        "content": gene_content,
        "mime_type": "application/json",
        "hash": gene_id
    }

def create_bundle_id(gene: dict, capsules: list) -> str:
    """计算 Bundle ID"""
    bundle_content = f"{gene['id']}" + "".join([c['id'] for c in capsules])
    return f"bundle_{hashlib.sha256(bundle_content.encode()).hexdigest()[:16]}"

def publish_bundle(bundle_id: str, gene: dict, capsules: list) -> dict:
    """发布 Bundle 到 EvoMap"""
    url = f"{EVO_HUB_URL}/api/v1/a2a/publish"

    payload = {
        "agent_id": NODE_ID,
        "bundle_id": bundle_id,
        "assets": [gene] + capsules,
        "timestamp": datetime.utcnow().isoformat() + "Z"
    }

    headers = {
        "Content-Type": "application/json"
    }

    try:
        response = requests.post(url, json=payload, headers=headers, timeout=10)
        return {
            "status_code": response.status_code,
            "response": response.json() if response.content else {}
        }
    except requests.exceptions.RequestException as e:
        return {
            "status_code": None,
            "error": str(e)
        }

def main():
    print(f"=== 发布剩余知识资产到 EvoMap ===")
    print(f"时间: {datetime.utcnow().isoformat()}")
    print(f"节点: {NODE_ID}")
    print()

    # 资产列表
    assets = [
        {
            "file": "passive_income_assets/cron-best-practices-2026-03-02.md",
            "capsule_type": "knowledge",
            "gene_name": "cron-best-practices",
            "gene_description": "OpenClaw Cron 定时任务最佳实践与超时控制"
        },
        {
            "file": "passive_income_assets/model-router-best-practices-2026-03-02.md",
            "capsule_type": "knowledge",
            "gene_name": "model-router-best-practices",
            "gene_description": "AI Agent 模型路由最佳实践与成本控制"
        }
    ]

    results = []

    for i, asset in enumerate(assets, 1):
        print(f"[{i}/{len(assets)}] 发布: {asset['gene_name']}")
        print(f"  文件: {asset['file']}")

        try:
            # 创建 Gene
            gene = create_gene(
                name=asset['gene_name'],
                description=asset['gene_description'],
                category="optimize"
            )
            print(f"  Gene: {gene['id'][:16]}...")

            # 创建 Capsule
            capsule = create_capsule(
                file_path=asset['file'],
                capsule_type=asset['capsule_type']
            )
            print(f"  Capsule: {capsule['id'][:16]}...")

            # 计算 Bundle ID
            bundle_id = create_bundle_id(gene, [capsule])
            print(f"  Bundle: {bundle_id}")

            # 发布
            print(f"  发布中...")
            result = publish_bundle(bundle_id, gene, [capsule])

            if result.get('status_code') == 200:
                print(f"  ✅ 发布成功")
                print(f"  决策: {result['response'].get('decision', 'N/A')}")
            elif result.get('status_code') == 429:
                print(f"  ⚠️  速率限制")
                retry_after = result['response'].get('retry_after_ms', 0) / 1000
                print(f"  等待时间: {retry_after:.1f} 秒")
                time.sleep(retry_after + 1)

                # 重试
                print(f"  重试中...")
                result = publish_bundle(bundle_id, gene, [capsule])
                if result.get('status_code') == 200:
                    print(f"  ✅ 重试成功")
                else:
                    print(f"  ❌ 重试失败: {result}")
            else:
                print(f"  ❌ 发布失败: {result}")

            results.append({
                "asset": asset['gene_name'],
                "bundle_id": bundle_id,
                "result": result
            })

        except Exception as e:
            print(f"  ❌ 错误: {e}")
            results.append({
                "asset": asset['gene_name'],
                "error": str(e)
            })

        print()

    # 汇总结果
    print("=== 发布汇总 ===")
    success_count = sum(1 for r in results if r.get('result', {}).get('status_code') == 200)
    print(f"成功: {success_count}/{len(assets)}")
    print()

    # 保存日志
    log_file = f"passive_income_assets/publish_log_{datetime.now().strftime('%Y-%m-%d_%H-%M')}.md"
    with open(log_file, 'w') as f:
        f.write(f"# EvoMap 发布日志 - {datetime.utcnow().isoformat()}\n\n")
        f.write(f"## 发布概要\n\n")
        f.write(f"**时间**: {datetime.utcnow().isoformat()}\n")
        f.write(f"**成功**: {success_count}/{len(assets)}\n\n")
        f.write(f"## 详细结果\n\n")
        for r in results:
            f.write(f"### {r.get('asset', 'Unknown')}\n")
            f.write(f"- **Bundle ID**: {r.get('bundle_id', 'N/A')}\n")
            f.write(f"- **结果**: {r.get('result', r.get('error', 'Unknown'))}\n\n")

    print(f"日志已保存: {log_file}")

if __name__ == "__main__":
    main()
