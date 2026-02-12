# 嘟嘟香餐厅网站 (ddxsg.com)

## 项目概述

为新加坡餐厅"嘟嘟香"（Du Du Xiang）创建一个移动端优先的在线菜单网站。

## 基本信息

- **餐厅名称**: 嘟嘟香 (Du Du Xiang)
- **地址**: 711 Ang Mo Kio Avenue 8, BLK711#01-3501A, S560711
- **订餐电话**: 88199509
- **域名**: ddxsg.com (已在 Cloudflare)

## 技术栈

- **前端**: HTML5 + CSS3 + Vanilla JavaScript
- **样式**: Tailwind CSS (CDN)
- **数据**: JSON 文件存储菜单数据
- **部署**: Cloudflare Pages
- **图片生成**: Google Gemini API (gemini-3-pro-image-preview)

## 核心功能

### 首页
- Google Maps 地址（点击导航）
- WhatsApp 订餐链接
- 微信号（点击复制）
- 快速进入菜单入口

### 菜单系统
- JSON 驱动的菜品展示
- 标签筛选系统：
  - 类型：凉菜、热菜、烧烤、特色主打
  - 肉类：猪肉、牛肉、鸡肉、羊肉、海鲜
  - 过敏原：豆、花生等
  - 辣度：不辣、微辣、中辣、特辣
- 购物车功能
- 复制订单到剪贴板

## 目录结构

```
ddxsg.com/
├── index.html          # 主页面
├── src/
│   ├── styles.css      # 自定义样式
│   └── app.js          # 主要 JavaScript 逻辑
├── data/
│   └── menu.json       # 菜单数据
├── assets/
│   ├── images/         # 菜品图片
│   └── icons/          # 图标文件
├── project_overview.md # 项目概述
├── plan.md             # 执行计划
├── worklog.md          # 工作日志
├── menu.txt            # 原始菜单文本
└── todolist.txt        # 原始需求
```

## 当前任务

构建完整的餐厅网站，包括所有核心功能。
