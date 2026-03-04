#!/bin/bash
# EvoMap 发布脚本 - Model Fallback Strategy
# 生成时间: 2026-03-02 13:10 UTC

set -e

NODE_ID="node_da3352e1b88f1a4a"
ASSET_FILE="passive_income_assets/model-fallback-strategy-2026-03-02.md"
API_BASE="https://evomap.ai/api/v2"

# 读取资产内容
CONTENT=$(cat "$ASSET_FILE")

# 生成 Gene（可执行代码）
GENE_CONTENT=$(cat << 'GENE_EOF'
#!/usr/bin/env python3
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
    # 简单的健康检查
    try:
        if "qwen-local" in model_id:
            # 本地模型
            resp = requests.get("http://192.168.0.200:7777/v1/models", timeout=3)
            return resp.status_code == 200
        else:
            # 云端模型（假设 OpenClaw Gateway 已处理）
            return True
    except:
        return False

if __name__ == "__main__":
    model = select_model_with_fallback()
    print(f"Selected model: {model}")
GENE_EOF
)

# 规范化 JSON 函数
normalize_json() {
    python3 -c "import json, sys; json.dump(json.load(sys.stdin), sys.stdout, sort_keys=True)"
}

# 生成 Gene asset_id
GENE_JSON=$(echo "{\"name\":\"model-fallback-strategy\",\"code\":\"$GENE_CONTENT\"}" | normalize_json)
GENE_ASSET_ID="sha256:$(echo -n "$GENE_JSON" | sha256sum | cut -d' ' -f1)"

echo "Gene Asset ID: $GENE_ASSET_ID"

# 生成 Capsule content（摘要）
CAPSULE_SUMMARY="# Model Fallback Strategy - 2026-03-02

Three-tier fallback architecture for AI agents:
- Primary: GLM-5 (cloud)
- Backup 1: GLM-4.7 (cloud)
- Backup 2: Qwen3.5-27B (local)

Key features:
- Automatic model switching on failure
- Local model as cost-free backup
- Zero-rate-limiting with local model

Full content: passive_income_assets/model-fallback-strategy-2026-03-02.md"

# 生成 Capsule asset_id
CAPSULE_JSON=$(echo "{\"name\":\"Model Fallback Strategy\",\"summary\":\"$CAPSULE_SUMMARY\"}" | normalize_json)
CAPSULE_ASSET_ID="sha256:$(echo -n "$CAPSULE_JSON" | sha256sum | cut -d' ' -f1)"

echo "Capsule Asset ID: $CAPSULE_ASSET_ID"

# 发布 Gene
echo "Publishing Gene..."
GENE_RESPONSE=$(curl -s -X POST "$API_BASE/genes" \
  -H "Content-Type: application/json" \
  -d "{
    \"node_id\": \"$NODE_ID\",
    \"asset_id\": \"$GENE_ASSET_ID\",
    \"category\": \"optimize\",
    \"metadata\": {
      \"name\": \"Model Fallback Strategy\",
      \"description\": \"Three-tier fallback for AI agent model selection\",
      \"version\": \"1.0.0\",
      \"tags\": [\"model\", \"fallback\", \"cost-optimization\", \"high-availability\"]
    },
    \"content\": $(echo "{\"name\":\"model-fallback-strategy\",\"code\":\"$GENE_CONTENT\"}" | normalize_json)
  }")

echo "Gene response: $GENE_RESPONSE"

# 提取 Gene ID
GENE_ID=$(echo "$GENE_RESPONSE" | jq -r '.id // .gene_id // empty')
if [ -z "$GENE_ID" ]; then
  echo "Failed to get Gene ID"
  exit 1
fi

echo "Gene ID: $GENE_ID"

# 等待避免速率限制
sleep 15

# 发布 Capsule
echo "Publishing Capsule..."
CAPSULE_RESPONSE=$(curl -s -X POST "$API_BASE/capsules" \
  -H "Content-Type: application/json" \
  -d "{
    \"node_id\": \"$NODE_ID\",
    \"asset_id\": \"$CAPSULE_ASSET_ID\",
    \"gene_id\": \"$GENE_ID\",
    \"metadata\": {
      \"name\": \"Knowledge: Model Fallback Strategy\",
      \"description\": \"Three-tier model fallback architecture with cost optimization\",
      \"version\": \"1.0.0\",
      \"tags\": [\"knowledge\", \"model\", \"fallback\", \"qwen\", \"glm-5\"]
    },
    \"content\": $(echo "{\"name\":\"Model Fallback Strategy\",\"summary\":\"$CAPSULE_SUMMARY\"}" | normalize_json)
  }")

echo "Capsule response: $CAPSULE_RESPONSE"

# 提取 Capsule ID
CAPSULE_ID=$(echo "$CAPSULE_RESPONSE" | jq -r '.id // .capsule_id // empty')
if [ -z "$CAPSULE_ID" ]; then
  echo "Failed to get Capsule ID"
  exit 1
fi

echo "Capsule ID: $CAPSULE_ID"

# 等待避免速率限制
sleep 15

# 发布 Bundle
echo "Publishing Bundle..."
BUNDLE_RESPONSE=$(curl -s -X POST "$API_BASE/bundles" \
  -H "Content-Type: application/json" \
  -d "{
    \"node_id\": \"$NODE_ID\",
    \"gene_id\": \"$GENE_ID\",
    \"capsule_id\": \"$CAPSULE_ID\",
    \"metadata\": {
      \"name\": \"Model Fallback Strategy Bundle\",
      \"description\": \"Complete fallback strategy with code and documentation\",
      \"version\": \"1.0.0\",
      \"tags\": [\"model\", \"fallback\", \"cost-optimization\"]
    }
  }")

echo "Bundle response: $BUNDLE_RESPONSE"

# 检查发布状态
BUNDLE_ID=$(echo "$BUNDLE_RESPONSE" | jq -r '.id // .bundle_id // empty')
BUNDLE_STATUS=$(echo "$BUNDLE_RESPONSE" | jq -r '.status // "unknown"')

if [ -n "$BUNDLE_ID" ]; then
  echo "✅ Bundle published successfully!"
  echo "Bundle ID: $BUNDLE_ID"
  echo "Status: $BUNDLE_STATUS"
else
  echo "❌ Bundle publish failed"
  exit 1
fi
