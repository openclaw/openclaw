# RedBookSkills 评估计划

**日期**：2026-03-03
**目标**：评估 RedBookSkills（whiteOdew/XiaohongshuSkills），决定是否用于小红书自动化发布

---

## 📋 项目信息

- **GitHub**：whiteOdew/XiaohongshuSkills
- **Stars**：~1.2k
- **状态**：活跃维护（最近更新几天前）
- **技术栈**：Python + Chrome DevTools Protocol (CDP)

---

## ✨ 核心功能

- ✅ **自动化发布**：自动填写标题、正文、上传图片
- ✅ **话题标签自动写入**：识别正文最后一行 #标签
- ✅ **多账号支持**：各账号 Cookie 隔离
- ✅ **无头模式**：后台运行，无需显示浏览器窗口
- ✅ **远程 CDP 支持**：通过 --host/--port 连接远程 Chrome
- ✅ **图片下载**：支持从 URL 自动下载，绕过防盗链
- ✅ **登录检测**：自动检测登录状态，未登录切换到窗口模式扫码
- ✅ **登录状态缓存**：本地缓存 12 小时
- ✅ **内容检索**：搜索笔记并获取详情（含评论数据）
- ✅ **笔记评论**：按 feed_id + xsec_token 发表评论
- ✅ **通知评论抓取**：抓取 /notification 页面
- ✅ **数据看板**：抓取笔记基础信息（曝光/观看/点赞）并导出 CSV

---

## 💡 与现有方案对比

### 现有方案：MCP 服务器

| 功能 | MCP 服务器 | RedBookSkills |
|------|-----------|---------------|
| 自动发布 | ❌ 不支持 | ✅ 支持 |
| 多账号 | ❌ 不支持 | ✅ 支持 |
| 无头模式 | ❌ 不支持 | ✅ 支持 |
| 图片处理 | ❌ 不支持 | ✅ 支持（URL 下载）|
| 登录缓存 | ❌ 不支持 | ✅ 支持（12小时）|
| 数据抓取 | ❌ 不支持 | ✅ 支持（导出CSV）|
| 部署复杂度 | 高（需要 MCP 服务器）| 低（直接安装）|
| 维护成本 | 高 | 低（开源活跃）|

### RedBookSkills 优势

1. **功能完整**：覆盖小红书自动化所有核心需求
2. **部署简单**：直接 clone 项目，无需额外基础设施
3. **活跃维护**：最近几天有更新，bug 修复及时
4. **无头模式**：适合定时任务和后台运行
5. **多账号支持**：可管理多个小红书账号

---

## 🔄 实施计划

### Phase 1：项目克隆与安装（优先级 P0）

#### 步骤 1：克隆项目
- [ ] 克隆 GitHub 仓库
- [ ] 查看项目结构
- [ ] 阅读 README.md

#### 步骤 2：依赖安装
- [ ] 安装 Python 依赖（requirements.txt）
- [ ] 检查是否需要特殊依赖（如 Chrome、chromedriver）
- [ ] 验证环境兼容性

#### 步骤 3：基础功能测试
- [ ] 测试登录功能
- [ ] 测试自动发布（单条笔记）
- [ ] 测试图片上传
- [ ] 测试话题标签识别

---

### Phase 2：与 OpenClaw 集成（优先级 P0）

#### 步骤 1：创建自动化脚本
- [ ] 封装 RedBookSkills 为 OpenClaw 脚本
- [ ] 传入参数：标题、正文、图片 URL、标签
- [ ] 返回结果：发布成功/失败、笔记链接

#### 步骤 2：集成到定时任务
- [ ] 创建 cron 任务：每小时发布一篇笔记
- [ ] 从 `xiaohongshu_content/` 读取待发布内容
- [ ] 发布后移到 `published/` 目录
- [ ] 记录发布日志

---

### Phase 3：高级功能测试（优先级 P1）

#### 步骤 1：多账号管理
- [ ] 配置多个小红书账号
- [ ] 测试账号隔离
- [ ] 实现轮换发布策略

#### 步骤 2：数据监控
- [ ] 测试笔记数据抓取（曝光、观看、点赞）
- [ ] 导出 CSV 分析
- [ ] 建立监控面板

#### 步骤 3：评论互动
- [ ] 测试自动回复评论
- [ ] 测试评论抓取
- [ ] 实现通知监控

---

## 🔧 技术实现

### 项目位置
- **克隆路径**：`~/redbook-skills/`
- **集成路径**：`scripts/xiaohongshu_auto_publisher.py`

### 账号配置
```python
XIAOHONGSHU_CONFIG = {
    "accounts": [
        {
            "name": "账号1",
            "cookie_file": "config/xhs_cookie1.json",
            "enabled": True
        },
        {
            "name": "账号2",
            "cookie_file": "config/xhs_cookie2.json",
            "enabled": False
        }
    ],
    "current_account": 0
}
```

### 发布流程
```python
# 1. 读取待发布内容
content = read_pending_post()

# 2. 调用 RedBookSkills 发布
result = xiaohongshu_post(
    title=content["title"],
    content=content["content"],
    images=content["images"],
    tags=content["tags"]
)

# 3. 处理结果
if result["success"]:
    move_to_published(content_file)
    log_publish(result)
else:
    log_error(result["error"])
```

---

## ⚠️ 风险与应对

### 风险 1：小红书反爬虫
**应对**：
- 使用 Cookie 登录（避免频繁扫码）
- 12 小时登录缓存
- 无头模式 + 降频发布（每小时 1 篇）

### 风险 2：账号封禁
**应对**：
- 多账号轮换发布
- 控制发布频率（不超过人工发布频率）
- 避免敏感内容

### 风险 3：依赖外部 Chrome
**应对**：
- 使用远程 CDP（如果 Chrome 在宿主机）
- 或 Docker 内安装 Chrome/chromedriver

---

## 📊 预期效果

| 指标 | 当前（MCP 服务器）| RedBookSkills | 提升 |
|------|------------------|---------------|------|
| 自动发布 | ❌ 不支持 | ✅ 支持 | +100% |
| 多账号 | ❌ 不支持 | ✅ 支持 | +100% |
| 无头模式 | ❌ 不支持 | ✅ 支持 | +100% |
| 部署复杂度 | 高 | 低 | -80% |
| 维护成本 | 高 | 低 | -70% |
| 日发布量 | 0 篇 | 24 篇 | +2400% |

---

## 📝 决策点

### 使用 RedBookSkills 的条件
- ✅ 项目功能完整，满足需求
- ✅ 活跃维护，bug 修复及时
- ✅ 部署简单，无需额外基础设施
- ✅ 无头模式，适合定时任务

### 继续使用 MCP 服务器的条件
- ❌ MCP 服务器未搭建完成
- ❌ 功能不明确，无法验证
- ❌ 部署复杂，维护成本高

---

## 🚀 立即行动

**A. 开始 Phase 1** → 克隆项目并测试基础功能
**B. 跳过评估** → 直接集成到定时任务
**C. 暂缓执行** → 先完成其他任务
**D. 继续优化** → Polymarket Phase 2（向量相似度）

---

**明确告知 A/B/C/D。**
