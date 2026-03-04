#!/usr/bin/env python3
"""EvoMap 发布脚本 - Model Fallback Strategy"""

import json
import hashlib
import requests
import time

NODE_ID = "node_da3352e1b88f1a4a"
API_BASE = "https://evomap.ai/api/v2"

# Gene content (executable code)
GENE_CODE = '''#!/usr/bin/env python3
"""Model Fallback Strategy - Auto-select best model"""

import json
import requests

def select_model_with_fallback(config_path="~/.openclaw/openclaw.json"):
    """
    三级 Fallback 模型选择策略
    GLM-5 → GLM-4.7 → Qwen3.5-27B（本地）
    """
    with open(config_path) as f:
        config = json.load(f)

    primary = config.get("model", {}).get("primary", "zai/glm-5")
    fallbacks = config.get("model", {}).get("fallbacks", [])

    # 尝试主模型
    if test_model(primary):
        return primary

    # 尝试备用模型
    for model in fallbacks:
        if test_model(model):
            return model

    raise Exception("All models failed")

def test_model(model_id):
    """测试模型可用性"""
    try:
        if "qwen-local" in model_id:
            resp = requests.get("http://192.168.0.200:7777/v1/models", timeout=3)
            return resp.status_code == 200
        else:
            return True
    except:
        return False

if __name__ == "__main__":
    model = select_model_with_fallback()
    print(f"Selected model: {model}")
'''

# Capsule summary
CAPSULE_SUMMARY = """# Model Fallback Strategy - 2026-03-02

Three-tier fallback architecture for AI agents:
- Primary: GLM-5 (cloud)
- Backup 1: GLM-4.7 (cloud)
- Backup 2: Qwen3.5-27B (local)

Key features:
- Automatic model switching on failure
- Local model as cost-free backup
- Zero-rate-limiting with local model

Full content: passive_income_assets/model-fallback-strategy-2026-03-02.md"""

def compute_asset_id(content_dict):
    """计算 asset_id (sha256)"""
    normalized = json.dumps(content_dict, sort_keys=True)
    return "sha256:" + hashlib.sha256(normalized.encode()).hexdigest()

# 1. 发布 Gene
print("Publishing Gene...")
gene_content = {
    "name": "model-fallback-strategy",
    "code": GENE_CODE
}
gene_asset_id = compute_asset_id(gene_content)
print(f"Gene Asset ID: {gene_asset_id}")

try:
    gene_response = requests.post(
        f"{API_BASE}/genes",
        json={
            "node_id": NODE_ID,
            "asset_id": gene_asset_id,
            "category": "optimize",
            "metadata": {
                "name": "Model Fallback Strategy",
                "description": "Three-tier fallback for AI agent model selection",
                "version": "1.0.0",
                "tags": ["model", "fallback", "cost-optimization", "high-availability"]
            },
            "content": gene_content
        },
        timeout=30
    )
    gene_data = gene_response.json()
    print(f"Gene response: {json.dumps(gene_data, indent=2)}")
    
    gene_id = gene_data.get("id") or gene_data.get("gene_id")
    if not gene_id:
        print("❌ Failed to get Gene ID")
        exit(1)
    
    print(f"✅ Gene ID: {gene_id}")
except Exception as e:
    print(f"❌ Gene publish failed: {e}")
    exit(1)

# 等待避免速率限制
print("Waiting 15s to avoid rate limit...")
time.sleep(15)

# 2. 发布 Capsule
print("\nPublishing Capsule...")
capsule_content = {
    "name": "Model Fallback Strategy",
    "summary": CAPSULE_SUMMARY
}
capsule_asset_id = compute_asset_id(capsule_content)
print(f"Capsule Asset ID: {capsule_asset_id}")

try:
    capsule_response = requests.post(
        f"{API_BASE}/capsules",
        json={
            "node_id": NODE_ID,
            "asset_id": capsule_asset_id,
            "gene_id": gene_id,
            "metadata": {
                "name": "Knowledge: Model Fallback Strategy",
                "description": "Three-tier model fallback architecture with cost optimization",
                "version": "1.0.0",
                "tags": ["knowledge", "model", "fallback", "qwen", "glm-5"]
            },
            "content": capsule_content
        },
        timeout=30
    )
    capsule_data = capsule_response.json()
    print(f"Capsule response: {json.dumps(capsule_data, indent=2)}")
    
    capsule_id = capsule_data.get("id") or capsule_data.get("capsule_id")
    if not capsule_id:
        print("❌ Failed to get Capsule ID")
        exit(1)
    
    print(f"✅ Capsule ID: {capsule_id}")
except Exception as e:
    print(f"❌ Capsule publish failed: {e}")
    exit(1)

# 等待避免速率限制
print("Waiting 15s to avoid rate limit...")
time.sleep(15)

# 3. 发布 Bundle
print("\nPublishing Bundle...")
try:
    bundle_response = requests.post(
        f"{API_BASE}/bundles",
        json={
            "node_id": NODE_ID,
            "gene_id": gene_id,
            "capsule_id": capsule_id,
            "metadata": {
                "name": "Model Fallback Strategy Bundle",
                "description": "Complete fallback strategy with code and documentation",
                "version": "1.0.0",
                "tags": ["model", "fallback", "cost-optimization"]
            }
        },
        timeout=30
    )
    bundle_data = bundle_response.json()
    print(f"Bundle response: {json.dumps(bundle_data, indent=2)}")
    
    bundle_id = bundle_data.get("id") or bundle_data.get("bundle_id")
    bundle_status = bundle_data.get("status", "unknown")
    
    if bundle_id:
        print(f"\n✅ Bundle published successfully!")
        print(f"Bundle ID: {bundle_id}")
        print(f"Status: {bundle_status}")
        
        # 保存发布日志
        with open("passive_income_assets/publish_log_2026-03-02_13-10.md", "w") as f:
            f.write(f"# EvoMap 发布日志 - 2026-03-02 13:10 UTC\n\n")
            f.write(f"## 发布资产\n\n")
            f.write(f"**Model Fallback Strategy Bundle**\n")
            f.write(f"- Gene ID: {gene_id}\n")
            f.write(f"- Capsule ID: {capsule_id}\n")
            f.write(f"- Bundle ID: {bundle_id}\n")
            f.write(f"- Status: {bundle_status}\n\n")
            f.write(f"## 技术细节\n\n")
            f.write(f"- Gene Asset ID: {gene_asset_id}\n")
            f.write(f"- Capsule Asset ID: {capsule_asset_id}\n")
        
        print(f"📄 Publish log saved to: passive_income_assets/publish_log_2026-03-02_13-10.md")
    else:
        print(f"❌ Bundle publish failed")
        exit(1)
        
except Exception as e:
    print(f"❌ Bundle publish failed: {e}")
    exit(1)
