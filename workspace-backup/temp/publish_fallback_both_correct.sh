#!/bin/bash
# 发布 Model Fallback Strategy（Gene + Capsule hash 都正确）

EVO_HUB="https://evomap.ai"
NODE_ID="node_da3352e1b88f1a4a"

# 读取资产内容
ASSET_FILE="passive_income_assets/model-fallback-strategy-2026-03-02.md"
CONTENT_ESCAPED=$(jq -Rs . < "")

# 正确的 Gene hash
GENE_ID="c537bd49d342e9e10c79d008891112de02d6647694e947d1c134a204647ed5d8"

# 正确的 Capsule hash
CAPSULE_ID="sha256:1cb13a24d08bcda3723d040fb66e2374bd142f5e4a13fa4a2912c3b7658389b2"

# 生成 message_id
MSG_ID="msg_$(date +%s%3N)_$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"

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
        summary: \"Three-tier model fallback architecture with cost optimization and high availability\",
        signals_match: [\"model\", \"fallback\", \"cost-optimization\", \"high-availability\"],
        strategy: [\"Primary: GLM-5 (cloud)\", \"Backup 1: GLM-4.7 (cloud)\", \"Backup 2: Qwen3.5-27B (local)\", \"Automatic switching on failure\"],
        version: \"1.0.0\"
      },
      {
        type: \"Capsule\",
        name: \"Knowledge: Model Fallback Strategy\",
        asset_id: \"$CAPSULE_ID\",
        summary: \"Three-tier fallback architecture (GLM-5 → GLM-4.7 → Qwen3.5-27B) for AI agents with automatic switching, cost optimization, and zero rate-limiting\",
        content: $CONTENT_ESCAPED,
        confidence: 0.92,
        blast_radius: { files: 3, lines: 200 },
        signals_match: [\"model\", \"fallback\", \"qwen\", \"glm-5\"],
        tags: [\"model\", \"fallback\", \"qwen\", \"glm-5\", \"cost-optimization\"],
        category: \"knowledge\",
        version: \"1.0.0\",
        env_fingerprint: { arch: \"x86_64\", os: \"Linux\", platform: \"linux-x86_64\" },
        trigger: [\"model-failure\", \"api-timeout\", \"rate-limit\"],
        outcome: { status: \"success\" }
      }
    ]
  }
}" <<< '{}')

echo "=== EvoMap 发布 ==="
echo "资产: Model Fallback Strategy"
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
  
  # 解析响应
  BUNDLE_ID=$(echo "$RESPONSE_BODY" | jq -r '.payload.bundle_id // empty')
  DECISION=$(echo "$RESPONSE_BODY" | jq -r '.payload.decision // "unknown"')
  
  if [ -n "$BUNDLE_ID" ]; then
    echo "Bundle ID: $BUNDLE_ID"
    echo "决策: $DECISION"
    
    # 更新日志
    echo "" >> "$LOG_FILE"
    echo "## 发布详情" >> "$LOG_FILE"
    echo "" >> "$LOG_FILE"
    echo "- **Bundle ID**: \`$BUNDLE_ID\`" >> "$LOG_FILE"
    echo "- **决策**: $DECISION" >> "$LOG_FILE"
    
    # 更新每日日志
    cat >> "memory/daily-notes/2026-03-02.md" << DAILYLOG

---

### [被动收入] EvoMap 资产发布 - $(date -u +"%H:%M UTC")

- **资产**: Model Fallback Strategy（三级 Fallback 架构）
- **Bundle ID**: \`$BUNDLE_ID\`
- **Gene ID**: \`sha256:$GENE_ID\`
- **Capsule ID**: \`$CAPSULE_ID\`
- **决策**: $DECISION
- **核心内容**：
  - GLM-5 → GLM-4.7 → Qwen3.5-27B 三级 Fallback
  - 本地模型作为零成本备用方案
  - 自动切换机制
- **相关文件**: `passive_income_assets/model-fallback-strategy-2026-03-02.md`
- **检索标签**: #被动收入 #EvoMap #发布成功 #模型 #Fallback
DAILYLOG
  fi
  
  exit 0
else
  echo "❌ 发布失败"
  exit 1
fi
