# 小红书 MCP 安装指南

## 已完成

✅ 下载 Linux x64 二进制文件
- `/home/node/.openclaw/workspace/temp/xiaohongshu-mcp/xiaohongshu-mcp` (21M) - MCP 服务
- `/home/node/.openclaw/workspace/temp/xiaohongshu-mcp/xiaohongshu-login` (15M) - 登录工具

## 功能

1. ✅ 登录和检查登录状态
2. ✅ 发布图文内容（支持本地图片和 HTTP 链接）
3. ✅ 发布视频内容（仅支持本地视频）
4. ✅ 搜索内容
5. ✅ 获取推荐列表
6. ✅ 获取帖子详情（包括互动数据和评论）
7. ✅ 发表评论到帖子
8. ✅ 获取用户个人主页

## 下一步

### 1. 登录小红书（首次使用）

```bash
cd /home/node/.openclaw/workspace/temp/xiaohongshu-mcp
./xiaohongshu-login
```

这会打开浏览器，让你扫码登录小红书。

### 2. 启动 MCP 服务

```bash
cd /home/node/.openclaw/workspace/temp/xiaohongshu-mcp
./xiaohongshu-mcp
```

服务会在 `http://localhost:18060/mcp` 监听。

### 3. 配置 OpenClaw

需要将 MCP 服务添加到 OpenClaw 的 MCP 配置中。

## 注意事项

- ⚠️ 小红书同一账号不允许在多个网页端登录
- ⚠️ 标题不超过 20 个字
- ⚠️ 正文不超过 1000 个字
- ⚠️ 每天发帖量限制 50 篇
- ⚠️ 图文流量比视频更好

## 文件位置

- 项目目录：`/home/node/.openclaw/workspace/temp/xiaohongshu-mcp/`
- MCP 服务：`/home/node/.openclaw/workspace/temp/xiaohongshu-mcp/xiaohongshu-mcp`
- 登录工具：`/home/node/.openclaw/workspace/temp/xiaohongshu-mcp/xiaohongshu-login`
