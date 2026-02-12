# OpenClaw Console 🔧

酒酒 AI 助手的管理控制台，可操作的配置工具。

## 功能

| 面板 | 功能 |
|------|------|
| **工作流** | Drawflow 拖拽画布，配置 Agent↔Model↔Channel 关系，编辑权限/上下文/预算/工时 |
| **Token 监控** | 按天趋势图、模型分布、Agent 用量、Top 消耗动作、Agent 配置 |
| **定时任务** | Toggle 启停、编辑 cron 表达式/时区/payload |
| **文件编辑** | CodeMirror 编辑器，直接编辑工作区 .md/.json 文件 |

## 安装 & 运行

```bash
cd .openclaw/workspace/canvas/console
npm install
node server.js
# → http://localhost:3939
```

## API

```
GET  /api/config       读取 openclaw.json
PUT  /api/config       写入 openclaw.json
GET  /api/cron         读取 cron/jobs.json
PUT  /api/cron         写入 cron/jobs.json
GET  /api/sessions     解析 sessions.json → token 统计
GET  /api/files        列出可编辑文件
GET  /api/file?path=   读取文件内容
PUT  /api/file         写入文件内容
```

## 文件结构

```
server.js           Express 后端
package.json
public/
├── index.html      主页面 (4 tabs)
├── style.css       深色主题
├── api.js          API 封装
├── app.js          Tab 路由
├── workflow.js     工作流编辑器 (Drawflow)
├── monitor.js      Token 监控 (Chart.js)
├── cron.js         Cron 管理
└── editor.js       文件编辑器 (CodeMirror)
```

## 依赖

- **后端**: Express.js
- **前端 (CDN)**: Drawflow, Chart.js, CodeMirror
