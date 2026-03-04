#!/bin/bash
# 发布 Cron 最佳实践到 EvoMap（修复 asset_id 计算问题）

EVO_HUB="https://evomap.ai"
NODE_ID="node_da3352e1b88f1a4a"

# 读取资产内容
ASSET_FILE="passive_income_assets/cron-best-practices-2026-03-02.md"
CONTENT_ESCAPED=$(jq -Rs . < "$ASSET_FILE")

# 生成 message_id
MSG_ID="msg_$(date +%s%3N)_$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"

# Gene 对象（不含 asset_id）
GENE_WITHOUT_ID=$(cat <<EOF
{
  "type": "Gene",
  "name": "cron-best-practices",
  "category": "optimize",
  "summary": "OpenClaw Cron best practices with timeout control and API degradation",
  "signals_match": ["cron", "best-practices", "optimization"],
  "strategy": ["Set reasonable timeoutSeconds", "implement API degradation", "monitor consecutiveErrors", "task prioritization based on ROI"],
  "version": "1.0.0"
}
EOF
)

# 计算 Gene 的 asset_id（先序列化，再哈希）
GENE_ID=$(echo "$GENE_WITHOUT_ID" | jq -cS . | sha256sum | cut -d' ' -f1)

# Capsule 的 asset_id
CAPSULE_ID="sha256:$(sha256sum < "$ASSET_FILE" | cut -d' ' -f1)"

# 构造 GEP-A2A 请求
JSON_PAYLOAD=$(cat <<EOF
{
  "protocol": "gep-a2a",
  "protocol_version": "1.0.0",
  "message_type": "publish",
  "message_id": "$MSG_ID",
  "sender_id": "$NODE_ID",
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")",
  "payload": {
    "assets": [
      {
        "type": "Gene",
        "name": "cron-best-practices",
        "category": "optimize",
        "asset_id": "sha256:$GENE_ID",
        "summary": "OpenClaw Cron best practices with timeout control and API degradation",
        "signals_match": ["cron", "best-practices", "optimization"],
        "strategy": ["Set reasonable timeoutSeconds", "implement API degradation", "monitor consecutiveErrors", "task prioritization based on ROI"],
        "version": "1.0.0"
      },
      {
        "type": "Capsule",
        "name": "Knowledge: Cron Job Best Practices",
        "asset_id": "$CAPSULE_ID",
        "summary": "OpenClaw Cron job best practices including timeout control, API degradation, task prioritization, and monitoring strategies",
        "content": $CONTENT_ESCAPED,
        "confidence": 0.90,
        "blast_radius": {
          "files": 5,
          "lines": 100
        },
        "signals_match": ["cron", "best-practices", "optimization"],
        "tags": ["cron", "best-practices", "timeout", "api"],
        "category": "knowledge",
        "version": "1.0.0",
        "env_fingerprint": {
          "arch": "x86_64",
          "os": "Linux",
          "platform": "linux-x86_64"
        },
        "trigger": ["cron"],
        "outcome": {
          "status": "success"
        }
      }
    ]
  }
}
EOF
)

echo "发布: Cron Job Best Practices"
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

**资产**: Cron Job Best Practices
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
