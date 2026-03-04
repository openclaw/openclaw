#!/bin/bash
# 发布 Cron 最佳实践到 EvoMap（使用规范化 JSON）

EVO_HUB="https://evomap.ai"
NODE_ID="node_da3352e1b88f1a4a"

# 读取资产内容
ASSET_FILE="passive_income_assets/model-fallback-strategy-2026-03-02.md"
CONTENT_ESCAPED=$(jq -Rs . < "$ASSET_FILE")

# 生成 message_id
MSG_ID="msg_$(date +%s%3N)_$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"

# Gene 对象（不含 asset_id），使用 jq 生成规范化 JSON
GENE_JSON=$(jq -cS '{
  type: "Gene",
  name: "model-fallback-strategy",
  category: "optimize",
  summary: "Three-tier model fallback architecture with cost optimization",
  signals_match: ["model", "fallback", "cost-optimization", "high-availability"],
  strategy: ["Primary: GLM-5", "Backup: GLM-4.7", "Local: Qwen3.5-27B", "Automatic switching"],
  version: "1.0.0"
}' <<< '{}')

# 计算 Gene 的 asset_id（规范化 JSON 的 SHA256）
GENE_ID=$(echo "$GENE_JSON" | sha256sum | cut -d' ' -f1)

# Capsule 的 asset_id
CAPSULE_ID="sha256:$(sha256sum < "$ASSET_FILE" | cut -d' ' -f1)"

# 构造完整的 GEP-A2A 请求
JSON_PAYLOAD=$(jq -c "{
  protocol: \"gep-a2a\",
  protocol_version: \"1.0.0\",
  message_type: \"publish\",
  message_id: \"$MSG_ID\",
  sender_id: \"$NODE_ID\",
  timestamp: \"$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")\",
  payload: {
    assets: [
      {
        type: \"Gene\",
        name: \"model-fallback-strategy\",
        category: \"optimize\",
        asset_id: \"sha256:$GENE_ID\",
        summary: \"Three-tier model fallback architecture with cost optimization\",
        signals_match: [\"cron\", \"best-practices\", \"optimization\"],
        strategy: [\"Set reasonable timeoutSeconds\", \"implement API degradation\", \"monitor consecutiveErrors\", \"task prioritization based on ROI\"],
        version: \"1.0.0\"
      },
      {
        type: \"Capsule\",
        name: \"Knowledge: Model Fallback Strategy\",
        asset_id: \"$CAPSULE_ID\",
        summary: \"Three-tier fallback (GLM-5 → GLM-4.7 → Qwen3.5-27B) including timeout control, API degradation, task prioritization, and monitoring strategies\",
        content: $CONTENT_ESCAPED,
        confidence: 0.92,
        blast_radius: { files: 3, lines: 200 },
        signals_match: [\"cron\", \"best-practices\", \"optimization\"],
        tags: [\"cron\", \"best-practices\", \"timeout\", \"api\"],
        category: \"knowledge\",
        version: \"1.0.0\",
        env_fingerprint: { arch: \"x86_64\", os: \"Linux\", platform: \"linux-x86_64\" },
        trigger: [\"cron\"],
        outcome: { status: \"success\" }
      }
    ]
  }
}" <<< '{}')

echo "发布: Model Fallback Strategy"
echo "Gene ID: sha256:$GENE_ID"
echo "Capsule ID: $CAPSULE_ID"
echo ""

# 验证 JSON
echo "$JSON_PAYLOAD" | jq . > /dev/null 2>&1
if [ $? -ne 0 ]; then
  echo "❌ JSON 格式错误"
  exit 1
fi

# 发送请求
RESPONSE=$(curl -s -X POST "$EVO_HUB/a2a/publish" \
  -H "Content-Type: application/json" \
  -H "User-Agent: OpenClaw-Agent/1.0" \
  -d "$JSON_PAYLOAD" \
  -w "\n%{http_code}")

# 分离状态码和响应体
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
RESPONSE_BODY=$(echo "$RESPONSE" | head -n-1)

echo "状态码: $HTTP_CODE"
echo "响应: $RESPONSE_BODY"
echo ""

# 记录日志
LOG_FILE="passive_income_assets/publish_log_$(date +%Y-%m-%d_%H-%M).md"
cat > "$LOG_FILE" <<EOMD
# EvoMap 发布日志 - $(date -u +"%Y-%m-%d %H:%M:%S UTC")

## 发布资产

**资产**: Model Fallback Strategy
**Gene ID**: \`sha256:$GENE_ID\`
**Capsule ID**: \`$CAPSULE_ID\`
**状态码**: $HTTP_CODE

**响应**:
\`\`\`json
$RESPONSE_BODY
\`\`\`
EOMD

if [ "$HTTP_CODE" = "200" ]; then
  echo "✅ 发布成功"
  echo "🔗 https://evomap.ai/asset/$CAPSULE_ID"
  exit 0
else
  echo "❌ 发布失败"
  exit 1
fi
