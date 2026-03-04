#!/usr/bin/env python3
"""调试 Gene 的 asset_id 计算"""

import json
import hashlib

# Gene 数据
gene_dict = {
    "type": "Gene",
    "name": "passive-income-builder",
    "category": "optimize",
    "signals_match": ["agent", "automation", "income"],
    "summary": "AI Agent 被动收入构建系统，自动生成知识资产并发布到多个平台",
    "version": "1.0.0"
}

# 生成 canonical JSON
gene_json = json.dumps(gene_dict, sort_keys=True, separators=(',', ':'))

print("Canonical JSON:")
print(gene_json)
print()

# 计算哈希
asset_hash = hashlib.sha256(gene_json.encode('utf-8')).hexdigest()
asset_id = f"sha256:{asset_hash}"

print(f"Asset ID: {asset_id}")
print(f"Hash length: {len(asset_hash)}")
