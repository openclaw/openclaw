# 基础设施配置

## 系统环境

### 主机信息
- **操作系统**：Windows 10 + WSL2 (Ubuntu)
- **容器环境**：Docker（无 root 权限）
- **工作目录**：`/home/node/.openclaw/workspace`

### AI 模型配置
- **主模型**：智谱 GLM-5（Coding Plan Max）
  - API：`https://open.bigmodel.cn/api/coding/paas/v4`
  - Context：128K tokens
  - 备用：GLM-4.7（128K）、GLM-4.6（200K）
- **本地模型**：Qwen3.5-27B
  - 地址：`http://192.168.0.200:7777/v1`
  - 用途：备用、节省成本

### 网络配置
- **代理**：`http://host.docker.internal:7890`
- **用途**：访问外部 API、绕过地区限制

### IM 渠道
- **飞书**：已接入（主要）
  - 用户 ID：`ou_1e09e54bff729f5af7671442667b6803`
  - 群聊：软件研发群（`oc_a8aa6b7f2a13b3cb610a419d70a2f870`）

---

## 外部服务

### Polymarket
- **钱包地址**：`0x3a022c81d06c9c907d6fcc7ddd846083bfc3bd33`
- **链**：Polygon（Chain ID: 137）
- **当前持仓**：3 个（15 USDC 投入）
- **API 凭证**：`config/polymarket.env`

### 水产市场（OpenClawMP）
- **Device ID**：`12120c5db8474559257131882339c901cebda6d113bfd11233c979543b71b86a`
- **API Base**：`https://openclawmp.cc`
- **已发布资产**：23 个
- **Auth Token**：待配置

### EvoMap
- **节点 ID**：`node_da3352e1b88f1a4a`
- **状态**：在线（500 credits）
- **已发布资产**：3 个知识资产

---

## API 密钥管理

### 安全规范
- ❌ **绝不硬编码**到代码中
- ✅ **使用环境变量**或配置文件
- ✅ **文件权限**：600（仅所有者可读写）
- ✅ **.gitignore**：排除所有密钥文件

### 密钥位置
| 服务 | 文件位置 | 说明 |
|------|---------|------|
| 智谱 AI | `openclaw.json` → `env.ZHIPU_API_KEY` | GLM-5 模型 |
| GitHub | `openclaw.json` → `env.GITHUB_TOKEN` | 仓库访问 |
| Anthropic | `openclaw.json` → `env.ANTHROPIC_AUTH_TOKEN` | Claude 模型 |
| Polymarket | `config/polymarket.env` | 交易 API |
| OpenClawMP | `~/.openclawmp/config.json` | 水产市场（待配置） |

---

## 定时任务（Cron）

### 已配置任务
1. **Polymarket 持仓监控**
   - 频率：每 5 分钟
   - 脚本：`projects/polymarket-sniper/polymarket_sniper_optimized.py`
   - 日志：`/tmp/polymarket_sniper.log`

2. **技能自动更新**
   - 频率：每天凌晨 3 点
   - 脚本：`/home/node/.openclaw/scripts/daily_skills_update.sh`
   - 日志：`/tmp/clawhub_update.log`

### 待配置任务
- Polymarket 自动交易（等待充值后启用）
- XiaoHongShu 自动发布（等待 Cookie 配置）
- 水产市场资产发布（等待 Auth Token）

---

## 依赖环境

### Python 依赖
**已安装**（2026-03-03 15:45）：
- ✅ pip 26.0.1
- ✅ py-clob-client 0.34.6
- ✅ web3 7.14.1
- ✅ 50+ 个依赖包

**安装命令**：
```bash
pip install --break-system-packages py-clob-client web3
```

### Node.js 环境
- **版本**：v22.22.0
- **包管理器**：npm
- **全局命令**：`clawhub`、`openclawmp`

---

## 故障排查

### 常见问题

1. **Docker 不可用**
   - 现象：`docker: not found`
   - 原因：容器环境，无 root 权限
   - 解决：使用宿主机 Docker 或调整架构

2. **pip 不可用**
   - 现象：`ModuleNotFoundError: No module named 'pip'`
   - 解决：`python3 /tmp/get-pip.py --user --break-system-packages`

3. **代理失效**
   - 现象：无法访问外部 API
   - 检查：`curl -x http://host.docker.internal:7890 https://google.com`
   - 解决：确认宿主机代理服务运行正常

4. **地区限制**
   - 现象：Polymarket API 返回 403/1010
   - 原因：Cloudflare 地区封锁
   - 解决：使用代理或手动操作

---

**最后更新**：2026-03-03 15:50
