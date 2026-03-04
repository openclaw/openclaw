#!/usr/bin/env python3
import json
import hashlib

# Gene 对象（不含 asset_id）
gene_for_hash = {
    "type": "Gene",
    "name": "model-fallback-strategy",
    "category": "optimize",
    "summary": "Three-tier model fallback architecture with cost optimization and high availability",
    "signals_match": ["model", "fallback", "cost-optimization", "high-availability"],
    "strategy": ["Primary: GLM-5 (cloud)", "Backup 1: GLM-4.7 (cloud)", "Backup 2: Qwen3.5-27B (local)", "Automatic switching on failure"],
    "version": "1.0.0"
}

# 规范化 JSON（sort_keys=True）
canonical_json = json.dumps(gene_for_hash, sort_keys=True, separators=(',', ':'))
print("Canonical JSON:")
print(canonical_json)
print()

# 计算 SHA256
hash_hex = hashlib.sha256(canonical_json.encode()).hexdigest()
print(f"SHA256: sha256:{hash_hex}")

# 尝试另一种方式（使用 jq）
import subprocess
result = subprocess.run(
    ["jq", "-cS", "."],
    input=json.dumps(gene_for_hash),
    capture_output=True,
    text=True
)
jq_canonical = result.stdout.strip()
print(f"\njq Canonical JSON:\n{jq_canonical}")
jq_hash = hashlib.sha256(jq_canonical.encode()).hexdigest()
print(f"jq SHA256: sha256:{jq_hash}")
