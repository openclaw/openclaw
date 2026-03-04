# 小红书 Cookie 配置指南

**创建时间**：2026-03-03 13:33
**目标**：配置小红书 Cookie 以启用自动发布

---

## 📋 配置步骤

### 步骤 1：登录小红书

1. **打开浏览器访问**：
   ```
   https://www.xiaohongshu.com
   ```

2. **扫码登录**
   - 使用小红书 APP 扫描屏幕上的二维码
   - 确认登录成功

---

### 步骤 2：导出 Cookie

#### 选项 A：使用浏览器插件（推荐）

**Chrome 浏览器**：
1. 安装 "EditThisCookie" 插件
   - 访问：https://chrome.google.com/webstore/detail/editthiscookie/
   - 点击 "添加到 Chrome"

2. 导出 Cookie：
   - 点击浏览器右上角的 Cookie 图标
   - 选择 "导出"
   - 选择 "JSON" 格式
   - 复制所有 Cookie 数据

**Firefox 浏览器**：
1. 安装 "Cookie-Editor" 插件
   - 访问：https://addons.mozilla.org/en-US/firefox/addon/cookie-editor/
   - 点击 "添加到 Firefox"

2. 导出 Cookie：
   - 右键点击 Cookie 图标
   - 选择 "导出"
   - 复制所有 Cookie 数据

#### 选项 B：使用开发者工具（无需插件）

1. **打开开发者工具**：
   - 按 `F12` 或右键 → "检查"
   - 切换到 "Application" 标签

2. **找到 Cookie**：
   - 左侧展开 "Cookies"
   - 点击 "https://www.xiaohongshu.com"

3. **复制关键 Cookie**：
   只需要复制最重要的 Cookie：
   - `web_session`
   - `webId`
   - `a1`
   - `webBuild`
   - 其他所有 Cookie

---

### 步骤 3：创建 Cookie 配置文件

**方法 A：在服务器上手动创建**

```bash
# 创建配置目录
mkdir -p /home/node/.openclaw/config

# 创建 Cookie 文件
cat > /home/node/.openclaw/config/xhs_cookie.json << 'EOF'
{
  "cookies": [
    {
      "name": "web_session",
      "value": "你的web_session值",
      "domain": ".xiaohongshu.com",
      "path": "/",
      "expires": 1234567890
    },
    {
      "name": "webId",
      "value": "你的webId值",
      "domain": ".xiaohongshu.com",
      "path": "/",
      "expires": 1234567890
    },
    {
      "name": "a1",
      "value": "你的a1值",
      "domain": ".xiaohongshu.com",
      "path": "/",
      "expires": 1234567890
    }
  ],
  "timestamp": "2026-03-03T13:33:00"
}
EOF
```

**方法 B：通过飞书发送给我**

如果你已经导出了 Cookie JSON，可以直接发给我，我帮你创建文件。

---

### 步骤 4：验证 Cookie 配置

```bash
# 检查文件是否创建成功
cat /home/node/.openclaw/config/xhs_cookie.json

# 测试发布脚本
cd /home/node/.openclaw/workspace
python3 scripts/xiaohongshu_auto_publisher.py \
    xiaohongshu_content/xhs_1772234975912_1.md
```

---

## 🔑 Cookie 格式说明

### 最小 Cookie（最少配置）

```json
{
  "cookies": [
    {
      "name": "web_session",
      "value": "你的值",
      "domain": ".xiaohongshu.com",
      "path": "/"
    }
  ],
  "timestamp": "2026-03-03T13:33:00"
}
```

### 完整 Cookie（推荐）

包含所有 Cookie，格式如下：

```json
{
  "cookies": [
    {
      "name": "web_session",
      "value": "xxxx",
      "domain": ".xiaohongshu.com",
      "path": "/",
      "expires": 1234567890,
      "httpOnly": true,
      "secure": true,
      "sameSite": "Lax"
    },
    {
      "name": "webId",
      "value": "xxxx",
      "domain": ".xiaohongshu.com",
      "path": "/",
      "expires": 1234567890
    }
    // ... 更多 Cookie
  ],
  "timestamp": "2026-03-03T13:33:00"
}
```

---

## ⚠️ 注意事项

1. **安全警告**：
   - Cookie 是敏感信息，包含登录凭证
   - 不要在公开场合分享
   - Cookie 过期后需要重新配置（12 小时）

2. **Cookie 过期**：
   - 小红书 Cookie 有效期通常 12-24 小时
   - 过期后需要重新登录并导出

3. **测试建议**：
   - 先用 1 篇内容测试
   - 确认发布成功后再批量发布

---

## 🚀 配置完成后

**测试单篇发布**：
```bash
cd /home/node/.openclaw/workspace
python3 scripts/xiaohongshu_auto_publisher.py \
    xiaohongshu_content/xhs_1772234975912_1.md
```

**批量发布所有内容**：
```bash
cd /home/node/.openclaw/workspace
python3 scripts/xiaohongshu_batch_publisher.py
```

**发布前 3 篇**：
```bash
cd /home/node/.openclaw/workspace
python3 scripts/xiaohongshu_batch_publisher.py --limit 3
```

---

## 📞 需要帮助？

如果配置遇到问题：
1. 检查 Cookie 格式是否正确
2. 检查文件路径是否正确
3. 查看脚本输出错误信息
4. 通过飞书联系我

---

**创建时间**：2026-03-03 13:33
**创建者**：朝堂
**版本**：v1.0
