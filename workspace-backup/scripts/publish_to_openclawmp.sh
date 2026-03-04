#!/bin/bash
# 水产市场资产发布脚本
# 用法：./publish_to_openclawmp.sh [skill-name]
# 示例：./publish_to_openclawmp.sh agent-autonomy-kit

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 检查 token
if [ -z "$OPENCLAWMP_TOKEN" ]; then
    echo -e "${RED}❌ 错误：未配置 OPENCLAWMP_TOKEN${NC}"
    echo ""
    echo "请先配置："
    echo "1. 访问 https://openclawmp.cc 获取邀请码"
    echo "2. 注册并获取 API Key"
    echo "3. export OPENCLAWMP_TOKEN=sk-xxx"
    exit 1
fi

SKILLS_DIR="$HOME/.openclaw/workspace/skills"
TEMP_DIR="/tmp/openclawmp-packages"

# 创建临时目录
mkdir -p "$TEMP_DIR"

# 如果指定了技能名，只发布该技能
if [ -n "$1" ]; then
    SKILLS=("$1")
else
    # 否则发布所有技能
    SKILLS=(
        "agent-autonomy-kit"
        "find-skills"
        "planning-with-files"
        "tavily-search"
        "remotion"
        "agent-browser"
        "bounty-hunter"
        "idea2mvp"
        "bilibili-message"
        "url-images-to-pdf"
    )
fi

echo -e "${GREEN}🐟 水产市场资产发布器${NC}"
echo "待发布技能数：${#SKILLS[@]}"
echo ""

for skill in "${SKILLS[@]}"; do
    SKILL_PATH="$SKILLS_DIR/$skill"

    if [ ! -d "$SKILL_PATH" ]; then
        echo -e "${YELLOW}⚠️  跳过 $skill：目录不存在${NC}"
        continue
    fi

    if [ ! -f "$SKILL_PATH/SKILL.md" ]; then
        echo -e "${YELLOW}⚠️  跳过 $skill：缺少 SKILL.md${NC}"
        continue
    fi

    echo -e "${GREEN}✅ 发布 $skill${NC}"

    # 读取 metadata
    NAME=$(grep "^name:" "$SKILL_PATH/SKILL.md" | head -1 | sed 's/name: *//' || echo "$skill")
    VERSION=$(grep "^version:" "$SKILL_PATH/SKILL.md" | head -1 | sed 's/version: *//' || echo "1.0.0")
    DESC=$(grep "^description:" "$SKILL_PATH/SKILL.md" | head -1 | sed 's/description: *//' | sed 's/"//g' || echo "Agent skill")

    # 打包
    cd "$SKILL_PATH"
    zip -r "$TEMP_DIR/$skill.zip" . -x "*.git*" -x "node_modules/*" -x "*.DS_Store" > /dev/null 2>&1

    # 发布
    RESPONSE=$(curl -s -X POST "https://openclawmp.cc/api/v1/assets/publish" \
        -H "Authorization: Bearer $OPENCLAWMP_TOKEN" \
        -F "package=@$TEMP_DIR/$skill.zip" \
        -F "metadata={\"name\":\"$skill\",\"type\":\"skill\",\"version\":\"$VERSION\",\"displayName\":\"$NAME\",\"description\":\"$DESC\",\"tags\":[\"automation\"]}")

    # 检查响应
    if echo "$RESPONSE" | grep -q '"success":true'; then
        ASSET_ID=$(echo "$RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | sed 's/"id":"//;s/"//')
        echo -e "   ${GREEN}✓ 发布成功${NC}"
        echo "   资产页：https://openclawmp.cc/asset/$ASSET_ID"
        echo "   安装：openclawmp install skill/@yourname/$skill"
    else
        ERROR=$(echo "$RESPONSE" | grep -o '"message":"[^"]*"' | sed 's/"message":"//;s/"//')
        echo -e "   ${RED}✗ 发布失败：$ERROR${NC}"
    fi

    echo ""
done

# 清理
rm -rf "$TEMP_DIR"

echo -e "${GREEN}✅ 发布流程完成${NC}"
