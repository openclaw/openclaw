# YouTube 视频自动化制作 - 执行计划

创建时间: 2026-03-01 22:42 UTC

## 目标

实现从"用户消息"到"YouTube 视频链接"的全自动化流程。

## 步骤

- [ ] 步骤1: 调研现有技能和 API
- [ ] 步骤2: 配置 HeyGen API（视频生成）
- [ ] 步骤3: 配置 YouTube Data API（视频上传）
- [ ] 步骤4: 实现脚本生成模块
- [ ] 步骤5: 实现 TTS 配音模块（可选）
- [ ] 步骤6: 实现 HeyGen 视频生成模块
- [ ] 步骤7: 实现 YouTube 上传模块
- [ ] 步骤8: 端到端测试

## 当前进度

正在执行: 步骤1 - 调研现有技能和 API

### 调研结果

**已安装技能**：
1. ✅ **NanoBanana-PPT-Skills** - PPT 图片 + 视频生成
   - 需要：GEMINI_API_KEY, KLING_ACCESS_KEY, KLING_SECRET_KEY
   - 功能：PPT → 图片 → 转场视频 → 完整视频

2. ✅ **ai-content-marketing-suite** - YouTube 视频数据分析
3. ✅ **bilibili-monitor** - B站视频监控

**所需 API**：
1. **HeyGen API** - AI 头像视频生成
   - 文档：https://docs.heygen.com/reference/quick-start
   - 认证：X-API-KEY header
   - 最简单方式：Video Agent API（一个 prompt → 一个视频）
   - 端点：POST https://api.heygen.com/v1/video_agent/generate

2. **YouTube Data API v3** - 视频上传
   - 需要：Google Cloud 项目 + OAuth 2.0
   - 文档：https://developers.google.com/youtube/v3/getting-started
   - 功能：上传视频、管理播放列表等

## 技术方案

### 方案 A：完整自动化（推荐）

**流程**：
```
用户消息 → 脚本生成 → TTS 配音 → HeyGen 视频 → YouTube 上传
```

**所需配置**：
1. HEYGEN_API_KEY（HeyGen）
2. Google Cloud OAuth credentials（YouTube）
3. （可选）TTS API（如果 HeyGen 配音不够好）

**优点**：
- 完全自动化
- 从消息到 YouTube 链接
- 每月 $100-500 被动收入潜力

**缺点**：
- 需要多个 API 配置
- OAuth 授权较复杂

### 方案 B：半自动化（快速开始）

**流程**：
```
用户消息 → 脚本生成 → HeyGen 视频 → 本地下载
```

**所需配置**：
1. HEYGEN_API_KEY（HeyGen）

**优点**：
- 配置简单（只需 1 个 API Key）
- 快速验证可行性
- 可以先手动上传 YouTube

**缺点**：
- 需要手动上传 YouTube
- 不是完全自动化

### 方案 C：使用现有 PPT 视频技能

**流程**：
```
用户消息 → 内容提取 → PPT 生成 → 视频合成 → YouTube 上传
```

**所需配置**：
1. GEMINI_API_KEY（Google）
2. KLING_ACCESS_KEY + KLING_SECRET_KEY（可灵 AI）
3. Google Cloud OAuth credentials（YouTube）

**优点**：
- 已有技能，配置简单
- PPT 风格专业
- 支持转场动画

**缺点**：
- 不是真人头像
- 需要可灵 AI 账号

## 推荐方案

**阶段 1**（立即开始）：方案 B - 半自动化
- 只需配置 HeyGen API
- 快速验证效果
- 手动上传 YouTube（1 周内）

**阶段 2**（1 周后）：升级到方案 A - 完整自动化
- 配置 YouTube Data API
- 实现完全自动化
- 开始批量生产

## 下一步行动

1. **获取 HeyGen API Key**
   - 访问：https://app.heygen.com/settings?nav=API
   - 复制 API Key
   - 发送给我

2. **测试 Video Agent API**
   - 使用 HeyGen API 生成第一个测试视频
   - 验证效果和质量

3. **配置 YouTube API**（阶段 2）
   - 创建 Google Cloud 项目
   - 启用 YouTube Data API v3
   - 配置 OAuth 2.0 凭证

## 成本估算

**HeyGen 定价**：
- Creator: $24/月（15 分钟视频）
- Business: $72/月（90 分钟视频）
- Enterprise: 自定义

**YouTube API**：
- 免费（每天 10,000 单位）

**预期收益**：
- 每月 10-20 个视频
- 每个视频 $10-50 广告收入（长期）
- 每月 $100-500 被动收入（6 个月后）
