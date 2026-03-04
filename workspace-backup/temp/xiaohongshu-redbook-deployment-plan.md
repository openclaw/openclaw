# 小红书 RedBookSkills 部署计划

**创建时间**：2026-03-03 13:00
**目标**：部署小红书自动发布系统并集成到 OpenClaw 定时任务

---

## ✅ Phase 1：基础脚本开发（已完成）

### 步骤 1：创建自动化脚本
- [x] 创建 `scripts/xiaohongshu_auto_publisher.py`
- [x] 实现内容解析（标题、正文、标签）
- [x] 支持标准格式（#标题\n---\n正文\n#标签）
- [x] 支持指令格式（**标题**：xxx）
- [x] Cookie 缓存机制（12小时有效期）
- [x] 测试解析功能 ✅

---

## 🔄 Phase 2：批处理与定时任务（进行中）

### 步骤 1：创建批处理脚本
- [ ] 创建 `scripts/xiaohongshu_batch_publisher.py`
- [ ] 扫描 `xiaohongshu_content/` 目录
- [ ] 批量发布待发布内容
- [ ] 发布后移到 `xiaohongshu_content/published/`
- [ ] 记录发布结果到 JSON

### 步骤 2：集成到定时任务
- [ ] 创建 cron 任务：每小时发布一篇笔记
- [ ] 从待发布队列取一篇
- [ ] 发布后记录到 `memory/daily-notes/`
- [ ] 失败重试机制（最多3次）

---

## 📋 Phase 3：内容库管理（待执行）

### 步骤 1：内容库整理
- [ ] 统计待发布内容数量
- [ ] 验证内容格式（标题、正文、标签）
- [ ] 建立发布队列

### 步骤 2：发布监控
- [ ] 记录每篇笔记的发布时间
- [ ] 跟踪笔记数据（阅读、点赞、收藏）
- [ ] 定期生成发布报告

---

## 📊 当前状态

- **脚本位置**：
  - 单篇发布：`/home/node/.openclaw/workspace/scripts/xiaohongshu_auto_publisher.py`
  - 批量发布：`/home/node/.openclaw/workspace/scripts/xiaohongshu_batch_publisher.py`
- **内容库**：`/home/node/.openclaw/workspace/xiaohongshu_content/`
- **待发布内容**：8 篇 ✅
- **发布结果**：`/home/node/.openclaw/workspace/xiaohongshu_publish_results.json`
- **Cookie 文件**：`/home/node/.openclaw/config/xhs_cookie.json`（待配置）

---

## ✅ 已完成功能

1. **内容解析** ✅
   - 支持标准格式（#标题\n---\n正文\n#标签）
   - 支持指令格式（**标题**：xxx）
   - 自动识别话题标签

2. **Cookie 缓存** ✅
   - 12 小时有效期
   - 自动检查缓存过期

3. **批处理功能** ✅
   - 自动扫描待发布内容
   - 按时间排序
   - 支持限制发布数量（--limit）
   - 发布成功后移动到 published/ 目录
   - 记录发布结果

---

## ⚠️ 待解决问题

1. **Cookie 配置**：需要手动登录小红书并导出 Cookie
   - 当前状态：❌ 未配置
   - 解决方案：
     - 方案A：手动登录浏览器，使用导出 Cookie 插件
     - 方案B：使用 OpenClaw Browser 工具实现自动登录

2. **自动登录**：需要实现浏览器自动化（使用 OpenClaw Browser 工具）
   - 当前状态：❌ 未实现
   - 解决方案：集成 `browser` 工具，实现扫码登录

3. **图片上传**：当前版本仅支持文字发布，图片上传待开发
   - 当前状态：❌ 未实现
   - 优先级：低（可后续优化）

---

## 📋 使用指南

### 手动发布流程（当前推荐）

由于 Cookie 尚未配置，使用以下手动发布流程：

```bash
# 1. 查看待发布内容
python3 /home/node/.openclaw/workspace/scripts/xiaohongshu_batch_publisher.py --dry-run

# 2. 发布单篇内容（获取发布指引）
python3 /home/node/.openclaw/workspace/scripts/xiaohongshu_auto_publisher.py xiaohongshu_content/xhs_1772234975912_1.md

# 3. 复制输出中的标题和正文，手动发布到小红书
```

### 配置 Cookie（半自动）

```bash
# 1. 登录小红书
浏览器访问：https://www.xiaohongshu.com

# 2. 导出 Cookie（使用浏览器插件）
推荐插件：
- Chrome: "EditThisCookie"
- Firefox: "Cookie-Editor"

# 3. 保存 Cookie 到文件
创建文件：/home/node/.openclaw/config/xhs_cookie.json
格式：{"cookies": [...], "timestamp": "2026-03-03T13:00:00"}

# 4. 测试发布
python3 /home/node/.openclaw/workspace/scripts/xiaohongshu_auto_publisher.py xiaohongshu_content/xhs_1772234975912_1.md
```

---

## 🚀 下一步行动

### 优先级 P0：Cookie 配置
- 用户手动登录并导出 Cookie
- 保存到 `/home/node/.openclaw/config/xhs_cookie.json`
- 测试发布功能

### 优先级 P1：定时任务集成
- 创建 cron 任务：每小时发布一篇
- 集成到 OpenClaw 定时任务系统

### 优先级 P2：自动登录
- 使用 OpenClaw Browser 工具
- 实现扫码登录流程
- 自动保存 Cookie

### 优先级 P3：图片上传
- 实现图片下载功能
- 集成图片上传到小红书
