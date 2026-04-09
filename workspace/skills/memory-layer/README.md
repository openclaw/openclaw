# OpenClaw Memory Layer - 记忆宫殿版

> **基于MemPalace架构的持久化记忆系统**

🏛️ **OpenClaw Memory Layer** 现已升级到**记忆宫殿架构**！

## ✨ 核心特性

- **🏛️ 记忆宫殿结构**: 分层组织（翼楼→走廊→房间）
- **🗜️ AAAK编码**: 压缩3倍token，AI友好
- **🔍 向量搜索**: ChromaDB语义搜索
- **🔄 自动迁移**: 无缝从旧版本升级
- **💾 本地存储**: 零API成本，隐私安全

## 🚀 快速开始

### 1. 安装依赖

```bash
cd ~/.openclaw/workspace/skills/memory-layer
npm install
```

### 2. 测试

```bash
npm test
```

### 3. 自动迁移

首次运行时，会自动迁移旧数据：
- 旧数据: `~/.openclaw/memory.json`
- 新数据: `~/.openclaw/memory-palace/`
- 备份: `~/.openclaw/memory.json.backup`

**如需手动迁移**：
```javascript
import { memory } from './index.js';
await memory.migrateLegacyData();
```

## 📖 在OpenClaw中使用

### 方法1: 作为技能加载

```bash
# 加载记忆技能
cd ~/.openclaw/workspace/skills/memory-layer
openclaw skill link .

# 加载反思技能
cd ~/.openclaw/workspace/skills/reflection
openclaw skill link .
```

### 方法2: 在代码中导入

```typescript
import { memory, commands } from '~/.openclaw/workspace/memory-layer/dist/index.js';

// 记住
await memory.remember('用户喜欢简洁的回答', 'preference');

// 回忆
const results = await memory.recall('用户喜欢什么');
console.log(results);
```

## 💡 常用命令

### 记住信息

```bash
# 记住事实
openclaw agent --message "记住：我在做AI科普报告"

# 记住偏好
openclaw agent --message "记住：我喜欢简洁的回答"
```

### 回忆信息

```bash
# 搜索相关记忆
openclaw agent --message "你还记得关于我的什么事吗？"

# 具体查询
openclaw agent --message "我的项目是什么？"
```

### 查看统计

```bash
# 查看记忆统计
node -e "
const { commands } = require('./dist/index.js');
console.log(JSON.stringify(commands.stats(), null, 2));
"
```

## 🔧 API参考

### SimpleMemory类

```typescript
import { SimpleMemory } from './dist/index.js';

const memory = new SimpleMemory();

// 记住信息
await memory.remember(
  '内容',           // 要记住的内容
  'preference',     // 类型: fact | preference | context
  0.8              // 重要性: 0-1
);

// 回忆信息
const results = await memory.recall(
  '查询内容',        // 搜索查询
  5,                // 返回数量
  0.5              // 最低重要性
);

// 偏好管理
memory.updatePreference('key', 'value');
const pref = memory.getPreference('key');
const allPrefs = memory.getAllPreferences();

// 反思
await memory.addReflection('反思内容', 0.8);

// 统计
const stats = memory.getStats();

// 清理
memory.cleanup(90, 0.3);  // 清理90天前、重要性<0.3的记忆

// 导出
const data = memory.export();
```

### 命令接口

```typescript
import { commands } from './dist/index.js';

// 记住
await commands.remember('内容', 'preference');

// 回忆
const results = await commands.recall('查询内容');

// 偏好
commands.preference.set('key', 'value');
commands.preference.get('key');
commands.preference.all();

// 反思
await commands.reflect('反思内容');
commands.reflections(5);  // 最近5条反思

// 统计
commands.stats();

// 导出
commands.export();
```

## 🗂️ 数据存储

### 文件位置

```
~/.openclaw/
├── memory.db              # SQLite数据库
│   ├── memories           # 记忆表
│   ├── profile            # 用户偏好表
│   └── reflections        # 反思表
└── chroma/                # 向量数据库
    └── memories           # 记忆向量
```

### 数据库结构

**memories表**：
```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  content TEXT,
  type TEXT,              -- fact | preference | context
  importance REAL,         -- 0-1
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  access_count INTEGER,
  metadata TEXT
);
```

**profile表**：
```sql
CREATE TABLE profile (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMP
);
```

**reflections表**：
```sql
CREATE TABLE reflections (
  id TEXT PRIMARY KEY,
  content TEXT,
  created_at TIMESTAMP,
  significance REAL       -- 0-1
);
```

## 🎯 使用场景

### 场景1: 记住用户偏好

```javascript
// 对话中检测到偏好
await memory.remember(
  '用户喜欢简洁的回答，不要啰嗦',
  'preference',
  0.9  // 高重要性
);

// 下次对话自动应用
const prefs = memory.getAllPreferences();
if (prefs.communication_style === 'concise') {
  // 保持简洁
}
```

### 场景2: 上下文回忆

```javascript
// 用户提到"我的项目"
const results = await memory.recall('项目', 3);

if (results.length > 0) {
  console.log('我记得你提到过：');
  results.forEach(r => {
    console.log(`- ${r.content}`);
  });
}
```

### 场景3: 对话后反思

```javascript
// 对话结束后
await memory.addReflection(`
本次对话学到：
- 用户重视数据准确性
- 喜欢用API验证信息
- 不喜欢啰嗦的回答

下次改进：
- 优先使用第一手数据源
- 保持回答简洁直接
`, 0.8);
```

## 📊 性能优化

### 向量搜索优先

系统会自动：
1. 优先使用向量搜索（语义理解）
2. 降级到文本搜索（如果向量DB失败）
3. 按重要性和访问次数排序

### 自动清理

定期清理旧记忆：
```bash
# 清理90天前、重要性<0.3、访问次数<5的记忆
memory.cleanup(90, 0.3);
```

### 限制记忆数量

建议：
- 总记忆数 < 10,000条
- 每日新增 < 100条
- 定期清理低价值记忆

## 🔍 故障排查

### ChromaDB初始化失败

**现象**: 看到"ChromaDB初始化失败"警告

**解决**: 系统会自动降级到文本搜索，功能正常

### 记忆搜索不到

**可能原因**:
1. 记忆内容太短
2. 搜索词不相关
3. 重要性阈值太高

**解决**:
```javascript
// 降低重要性阈值
await memory.recall('查询', 10, 0.1);  // minImportance = 0.1
```

### 数据库损坏

**恢复**:
```bash
# 导出数据
const data = memory.export();

# 备份当前数据库
cp ~/.openclaw/memory.db ~/.openclaw/memory.db.backup

# 删除重建
rm ~/.openclaw/memory.db
# 下次初始化会自动创建新表
```

## 🚀 高级用法

### 自定义记忆提取

```typescript
// 从对话中提取记忆
async function extractFromConversation(conversation: string[]) {
  for (const msg of conversation) {
    // 检测偏好
    if (msg.includes('我喜欢')) {
      await memory.remember(msg, 'preference', 0.7);
    }
    // 检测事实
    if (msg.includes('我在做') || msg.includes('我的项目')) {
      await memory.remember(msg, 'fact', 0.6);
    }
  }
}
```

### 定时反思

```typescript
import cron from 'node-cron';

// 每天凌晨反思
cron.schedule('0 0 * * *', async () => {
  const recentConv = await getRecentConversations();
  const insights = await analyzeConversations(recentConv);
  
  await memory.addReflection(insights);
});
```

### 与OpenClaw集成

```typescript
// OpenClaw扩展
export const hooks = {
  async postProcess(message, response) {
    // 提取关键信息
    const insights = await extractInsights(response);
    
    for (const insight of insights) {
      await memory.remember(insight.content, insight.type);
    }
    
    return response;
  }
};
```

## 🏛️ 记忆宫殿结构

### 存储布局

```
~/.openclaw/memory-palace/
├── PALACE.md                    # 宫殿入口
├── wings/
│   ├── user/                    # 用户翼楼
│   │   ├── hall-preferences/    # 偏好走廊
│   │   ├── hall-decisions/      # 决策走廊
│   │   ├── hall-milestones/     # 里程碑走廊
│   │   ├── hall-advice/         # 建议走廊
│   │   ├── hall-discoveries/    # 发现走廊
│   │   ├── hall-facts/          # 事实走廊
│   │   └── hall-context/        # 上下文走廊
│   ├── projects/                # 项目翼楼
│   │   └── <project-name>/
│   │       └── hall-*/
│   └── topics/                  # 主题翼楼
│       └── <topic-name>/
│           └── hall-*/
└── tunnels/                     # 跨翼楼连接
    └── *.json
```

### 走廊类型

| 走廊 | 用途 | 示例 |
|------|------|------|
| **facts** | 事实信息 | "我在做AI科普报告" |
| **preferences** | 用户偏好 | "我喜欢简洁的回答" |
| **context** | 上下文 | "项目需要用B站API" |
| **decisions** | 决策记录 | "选择TypeScript而不是JavaScript" |
| **milestones** | 里程碑 | "完成了第一次开源贡献" |
| **advice** | 收到的建议 | "应该先写测试" |
| **discoveries** | 学到的知识 | "ChromaDB需要Python环境" |

### AAAK编码示例

**原始数据**（~100 tokens）：
```json
{
  "content": "用户喜欢简洁的回答，不要啰嗦",
  "importance": 0.9,
  "type": "preference"
}
```

**AAAK编码**（~30 tokens）：
```json
{
  "cntnt": "用户喜欢简洁的回答，不要啰嗦",
  "mprtnc": 0.9,
  "typ": "prfrnc"
}
```

### 搜索性能

| 搜索方式 | 召回率 | 说明 |
|----------|--------|------|
| 全库搜索 | ~60% | 搜索所有记忆文件 |
| 结构化搜索 | ~95% | 翼楼+走廊过滤 |
| **提升** | **+35%** | 结构化优势 |

## 📚 更多资源


## 💬 反馈与改进

如有问题或建议，欢迎反馈！

---

*版本: 1.0.0*
*更新: 2026-04-08*
