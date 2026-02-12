# OpenClaw Dashboard 🍷

酒酒 AI 助手的展示仪表盘，纯静态 HTML/CSS/JS。

## 功能

- 身份卡 (名字、性格、生日)
- 模型管理面板 (Claude Opus / GPT-5.3 / GPT-5.2)
- Agent 列表 + 权限
- 定时任务状态
- 通道状态 (WhatsApp / Telegram / iMessage)
- 联系人目录
- 记忆时间线
- 工具概览
- 架构图 (指挥官-工人)
- 硬件信息
- 项目概览

## 运行

纯静态文件，用任何 HTTP 服务器即可：

```bash
npx -y http-server . -p 8899
```

或者通过 OpenClaw Gateway 访问：`http://localhost:18789/canvas/dashboard/`

## 文件

```
index.html   # 主页面
style.css    # 样式
app.js       # 交互逻辑
```
