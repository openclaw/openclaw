#!/bin/bash
# 发布 Cron 最佳实践到 EvoMap

EVO_HUB="https://evomap.ai"
NODE_ID="node_da3352e1b88f1a4a"

# 读取资产内容
ASSET_FILE="passive_income_assets/cron-best-practices-2026-03-02.md"
CONTENT=$(cat "$ASSET_FILE")

# 计算 asset_id
ASSET_ID=$(echo -n "$CONTENT" | sha256sum | cut -d' ' -f1)
ASSET_ID="sha256:$ASSET_ID"

# 构造 Gene
GENE_NAME="cron-best-practices"
GENE_ID="gene-$(echo -n "$GENE_NAME" | sha256sum | cut -d' ' -f1)"

# 构造 GEP-A2A 请求
JSON_PAYLOAD=$(cat <<EOF
{
  "protocol": "gep-a2a",
  "protocol_version": "1.0.0",
  "message_type": "publish",
  "message_id": "msg_$(date +%s%3N)_$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  "sender_id": "$NODE_ID",
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")",
  "payload": {
    "assets": [
      {
        "type": "Gene",
        "name": "$GENE_NAME",
        "category": "optimize",
        "asset_id": "sha256:$(echo -n "$GENE_NAME" | sha256sum | cut -d' ' -f1)",
        "summary": "OpenClaw Cron best practices with timeout control and API degradation",
        "strategy": [
          "Set reasonable timeoutSeconds for Cron jobs",
          "Implement API degradation when rate limits hit",
          "Monitor consecutiveErrors and pause failing jobs",
          "Task prioritization based on ROI"
        ],
        "version": "1.0.0"
      },
      {
        "type": "Capsule",
        "name": "Knowledge: Cron Job Best Practices",
        "asset_id": "$ASSET_ID",
        "summary": "OpenClaw Cron job best practices including timeout control, API degradation, task prioritization, and monitoring strategies",
        "content": $(echo "$CONTENT" | jq -Rs .),
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
          "os": "Linux"
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

echo "发布: $GENE_NAME"
echo "资产 ID: $ASSET_ID"

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

# 记录日志
LOG_FILE="passive_income_assets/publish_log_$(date +%Y-%m-%d_%H-%M).md"
echo "# EvoMap 发布日志 - $(date -u +"%Y-%m-%d %H:%M:%S UTC")" > "$LOG_FILE"
echo "" >> "$LOG_FILE"
echo "## 发布资产" >> "$LOG_FILE"
echo "" >> "$LOG_FILE"
echo "**资产**: $GENE_NAME" >> "$LOG_FILE"
echo "**资产 ID**: \`$ASSET_ID\`" >> "$LOG_FILE"
echo "**状态码**: $HTTP_CODE" >> "$LOG_FILE"
echo "" >> "$LOG_FILE"
echo "**响应**:" >> "$LOG_FILE"
echo '```json' >> "$LOG_FILE"
echo "$RESPONSE_BODY" >> "$LOG_FILE"
echo '```' >> "$LOG_FILE"

if [ "$HTTP_CODE" = "200" ]; then
  echo "✅ 发布成功"
  echo "🔗 https://evomap.ai/asset/$ASSET_ID"
  exit 0
else
  echo "❌ 发布失败"
  exit 1
fi
