# 水产市场发布 - 快速启动指南

**最后更新**：2026-03-01 10:50
**状态**：✅ 准备就绪，等待认证

---

## 🎯 一步到位发布

配置好 token 后，运行一条命令发布所有资产：

```bash
export OPENCLAWMP_TOKEN=sk-xxx
~/workspace/scripts/publish_to_openclawmp.sh
```

---

## 📋 前置条件

### 1. 获取邀请码并注册

1. 访问 [https://openclawmp.cc](https://openclawmp.cc)
2. 使用邀请码注册（如果需要）
3. 获取 API Key（格式：`sk-xxx`）

### 2. 配置环境变量

```bash
# 临时配置（当前会话）
export OPENCLAWMP_TOKEN=sk-xxx

# 永久配置（添加到 ~/.bashrc 或 ~/.zshrc）
echo 'export OPENCLAWMP_TOKEN=sk-xxx' >> ~/.bashrc
source ~/.bashrc
```

---

## 🚀 发布方式

### 方式 A：批量发布（推荐）

发布所有 10 个技能：

```bash
cd ~/workspace/scripts
./publish_to_openclawmp.sh
```

### 方式 B：单个发布

只发布某个技能：

```bash
./publish_to_openclawmp.sh agent-autonomy-kit
```

### 方式 C：手动发布（不推荐）

如果脚本有问题，可以手动发布：

```bash
cd ~/.openclaw/workspace/skills/agent-autonomy-kit
zip -r /tmp/agent-autonomy-kit.zip . -x "*.git*" -x "node_modules/*"

curl -X POST "https://openclawmp.cc/api/v1/assets/publish" \
  -H "Authorization: Bearer $OPENCLAWMP_TOKEN" \
  -F "package=@/tmp/agent-autonomy-kit.zip" \
  -F 'metadata={"name":"agent-autonomy-kit","type":"skill","version":"1.0.0"}'
```

---

## 📦 待发布资产清单

高优先级（3 个）：
1. ✅ agent-autonomy-kit - 自主工作能力
2. ✅ find-skills - 技能发现
3. ✅ planning-with-files - 任务规划

中优先级（2 个）：
4. ✅ tavily-search - AI 搜索
5. ✅ remotion - 视频创作

其他（5 个）：
6. ✅ agent-browser - 浏览器自动化
7. ✅ bounty-hunter - 赏金猎人
8. ✅ idea2mvp - 产品验证
9. ✅ bilibili-message - B站私信
10. ✅ url-images-to-pdf - 图片转 PDF

---

## 🔍 发布后验证

发布成功后会显示：
- 资产页面链接：`https://openclawmp.cc/asset/s-xxx`
- 安装命令：`openclawmp install skill/@yourname/skill-name`

验证方式：
1. 访问资产页面查看详情
2. 在另一个环境测试安装：`openclawmp install skill/@yourname/skill-name`

---

## ❓ 常见问题

### Q: 提示 "missing_package" 错误？
A: 确保打包命令正确执行，检查 zip 文件是否生成

### Q: 提示 "unauthorized" 错误？
A: 检查 OPENCLAWMP_TOKEN 是否正确配置

### Q: 如何更新已发布的资产？
A: 修改 SKILL.md 的 version 字段，重新运行发布脚本

---

## 📚 相关文档

- 发布队列详情：`memory/active-projects/openclawmp-publish-queue.md`
- 水产市场文档：`~/.openclaw/skills/openclawmp/SKILL.md`
- 技能目录：`~/.openclaw/workspace/skills/`

---

## 📝 发布记录

- **2026-03-01 10:50**：创建发布脚本和文档，等待 token 配置

---

**注意**：本指南会随着发布进度持续更新。
