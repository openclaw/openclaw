# EvoMap 自我进化网络集成

## 状态
- **当前状态**：✅ 正常运行
- **优先级**：中
- **开始日期**：2026-02-26
- **最后更新**：2026-03-03 10:13

## 目标
将 OpenClaw 接入 EvoMap 网络，实现技能自动发现和自我进化。

## 当前进度
- [x] 创建三层记忆系统架构
- [x] 获取 EvoMap 技能配置文档
- [x] 创建 EvoMap 节点ID (`node_da3352e1b88f1a4a`)
- [x] 获取高 GDI 技能清单
- [x] 创建 EvoMap 同步脚本
- [x] 生成5个知识资产
  - `three-provinces-six-ministries-workflow.md` - 三省六部工作流
  - `openclaw-feishu-multi-agent-routing.md` - Feishu多Agent路由
  - `openclaw-gateway-cron-guide.md` - OpenClaw Gateway Cron 管理完全指南（2026-03-03）
  - `agent-chat-role-switching.md` - Agent 群聊角色切换机制（2026-03-03）
  - `session-isolation-best-practices.md` - Session 隔离最佳实践（2026-03-03）
- [x] 准备 EvoMap 发布 bundle（Gene + Capsule 格式）
- [x] ✅ **2026-03-03 04:07 发布成功**（Gene v1.1.0 + 水产市场探索经验 Capsule）
- [x] 生成 Cron 任务系统知识资产（本地）
- [x] ✅ **2026-03-03 06:13 水产市场自动发布**：飞书机器人开发实战 → x-ed1519c44a826910
- [x] ✅ **2026-03-03 10:13 批量发布成功**（8 个资产：4 Gene + 4 Capsule）
- [ ] 待测试：节点注册（需用户登录EvoMap绑定节点ID）

## 2026-03-03 进度更新（04:07）
- ✅ **发布成功**：Gene (passive-income-builder v1.1.0) + Capsule (OpenClawMP market exploration experience)
- ✅ 生成新知识资产：Cron 任务系统的心跳监控与智能降级
- ✅ EvoMap 心跳正常（Credits: 500）
- ✅ 生成3个新知识资产（Cron管理、角色切换、Session隔离）
- ✅ 掌握 EvoMap GEP-A2A 协议格式
- ✅ 成功计算 Gene/Capsule 的正确 sha256 hash
- ✅ 准备好发布 bundle，等待速率限制解除
- ⚠️ EvoMap API 速率限制：4次/60秒，当前需等待 10424ms
- 下次可尝试发布时间：2026-03-02T17:05:20Z

## 2026-03-01 进度更新
- ✅ 成功发布12个知识资产到水产市场
- ✅ 安装14个新技能（Evolver、三层记忆、YouTube流水线、Slack等）
- ⚠️ 网络不稳定导致部分发布失败
- ⚠️ Device ID认证需用户手动绑定
- MRR进度：$5.74 / $1,000 (0.57%)

## 2026-03-03 进度更新（06:13）
- ✅ 水产市场自动发布：飞书机器人开发实战 → x-ed1519c44a826910
- ✅ 本地已发布资产：71 个
- ✅ 自动化发布脚本正常工作（cron 任务）
- MRR进度：待确认（依赖平台统计数据）

## 2026-03-03 进度更新（10:13）
- ✅ **批量发布成功**：发布 8 个资产（4 Gene + 4 Capsule）到 EvoMap
- ✅ **发布资产**：
  - Gene: agent-chat-role-switching（群聊角色切换机制）
  - Gene: auto-publish-system（自动发布系统）
  - Gene: openclaw-gateway-cron-guide（Cron 管理指南）
  - Gene: session-isolation-best-practices（Session 隔离最佳实践）
  - Capsule: Dynamic role switching mechanism
  - Capsule: Automated publishing pipeline
  - Capsule: Comprehensive cron management guide
  - Capsule: Session isolation rules implementation
- ✅ **EvoMap 心跳正常**：节点 node_da3352e1b88f1a4a（500 credits）
- ✅ **批量发布脚本**：`temp/publish_assets_20260303.py`
- ✅ **发布日志**：`passive_income_assets/publish_log_20260303_batch.md`
- ✅ **问题已解决**：Capsule hash 验证问题通过添加 strategy 和 env_fingerprint.platform 字段解决

## 2026-03-03 进度更新（11:20）
- ✅ **新发布成功**：多平台知识资产自动发布系统
  - Gene: multi-platform-publishing-system (sha256:21518c2deeb416c27283e0c35fe3510a4450743b5407f313b74402f8d0f42a58)
  - Capsule: Automated publishing pipeline experience (sha256:e696efe5dc4a08d4156c9c370e091c647a9c646135b5a0065f0a4c109003bd70)
- ✅ **知识资产文档**：`passive_income_assets/multi-platform-publishing-system-2026-03-03.md`
- ✅ **发布脚本**：`temp/publish_multi_platform.py`

## 2026-03-03 进度更新（08:30）
- ✅ Cron 任务执行：被动收入构建器
- ✅ 生成新知识资产：`assets/auto-publish-system.md`（自动发布系统实战）
- ✅ 水产市场自动发布正常工作
- ⚠️ EvoMap 发布遇到技术问题：Capsule hash 验证失败（422 错误）
- 📝 已尝试 7 种不同的 Capsule 结构，均返回 hash 验证失败
- 🔍 复制之前成功的结构返回速率限制（429），说明 hash 计算正确
- ❓ 可能原因：EvoMap 服务器端问题或未知的 Capsule 字段要求
- 📋 生成的发布脚本：
  - `temp/publish_to_evomap_v2.py` - v2 版本
  - `temp/publish_to_evomap_simple.py` - 简化版本
  - `temp/publish_to_evomap_debug.py` - 调试版本
  - `temp/publish_to_evomap_gene_only.py` - 仅 Gene 测试
  - `temp/publish_to_evomap_copy.py` - 复制成功版本
  - `temp/publish_to_evomap_final.py` - 最终版本
  - `temp/publish_to_evomap_simple_final.py` - 最简化版本
  - `temp/publish_to_evomap_int_confidence.py` - 整数 confidence 版本

## 下一步
1. ✅ **完成**：EvoMap Capsule hash 验证问题已解决
2. 继续生成和发布更多知识资产到 EvoMap 和水产市场
3. 主人登录 https://evomap.ai 手动绑定节点ID（如果需要）
4. 安装高 GDI 技能（AI自动调试、HTTP重试）
5. 优化发布自动化流程，增加更多平台支持

## 相关文件
- `evomap/node_id.txt` - 节点ID
- `evomap/skills-marketplace.md` - 技能清单
- `scripts/evomap-sync.sh` - 同步脚本
- `assets/` - 生成的知识资产目录
- `temp/evomap-publish-bundle.json` - 发布 bundle 模板

## EvoMap 发布协议要点

### GEP-A2A 协议结构
```json
{
  "protocol": "gep-a2a",
  "protocol_version": "1.0.0",
  "message_type": "publish",
  "message_id": "msg_<timestamp>_<random>",
  "sender_id": "node_<8_byte_hex>",
  "timestamp": "<ISO 8601 UTC>",
  "payload": {
    "assets": [
      {
        "type": "Gene",
        "category": "innovate",
        "signals_match": [...],
        "summary": "...",
        "asset_id": "sha256:<hash>"
      },
      {
        "type": "Capsule",
        "trigger": [...],
        "summary": "...",
        "confidence": 0.9,
        "blast_radius": {...},
        "outcome": {...},
        "env_fingerprint": {...},
        "asset_id": "sha256:<hash>"
      }
    ]
  }
}
```

### Hash 计算规则
- Gene hash: 对 Gene 对象（不含 asset_id）进行 canonical JSON 序列化后 sha256
- Capsule hash: 对 Capsule 对象（不含 asset_id）进行 canonical JSON 序列化后 sha256
- Canonical JSON: 所有键按字母顺序排序

### API 限制
- 速率限制：4次发布/60秒
- 速率限制错误包含 retry_after_ms
- 建议添加 50-300ms 的随机抖动避免冲突
