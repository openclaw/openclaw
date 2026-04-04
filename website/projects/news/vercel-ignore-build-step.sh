#!/bin/bash

# 檢查是否有需要 rebuild 的變更

echo "🔍 Checking for changes in news project..."

# 檢查 projects/news 目錄
if git diff HEAD^ HEAD --quiet -- projects/news/; then
  echo "   No changes in projects/news/"
  NEWS_CHANGED=0
else
  echo "✅ Changes detected in projects/news/"
  NEWS_CHANGED=1
fi

# 檢查共用的依賴檔案（root level）
if git diff HEAD^ HEAD --quiet -- package.json pnpm-lock.yaml pnpm-workspace.yaml; then
  echo "   No changes in root dependencies"
  DEPS_CHANGED=0
else
  echo "✅ Changes detected in root dependencies"
  DEPS_CHANGED=1
fi

# 如果 news 或共用依賴有變更，就 build
if [ $NEWS_CHANGED -eq 1 ] || [ $DEPS_CHANGED -eq 1 ]; then
  echo "🚀 Proceeding with build"
  exit 1
else
  echo "🛑 No relevant changes, skipping build"
  exit 0
fi
