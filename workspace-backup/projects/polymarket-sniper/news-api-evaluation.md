# Phase 1：免费新闻 API 评估报告

**日期**：2026-03-03
**目标**：评估可用的免费新闻 API，选择最佳方案

---

## 📋 评估对象

### 1. NewsAPI

**基本信息**：
- 官网：https://newsapi.org
- 类型：REST API
- 数据源：30,000+ 新闻来源

**免费计划**：
- 请求次数：100 次/天
- 历史数据：1 个月
- 搜索功能：✅ 支持
- 分类过滤：✅ 支持
- 国家过滤：✅ 支持

**限制**：
- 需要注册账号
- 需要 API Key
- 有速率限制

**适用场景**：
- ✅ 少量高频调用（如每小时 4 次）
- ✅ 需要精确搜索和过滤
- ❌ 大规模实时监控（100次/天不够）

**成本**：
- 免费层：$0
- Developer 层：$449/月（10,000 次/天）
- Business 层：$949/月（50,000 次/天）

---

### 2. RSS Feeds

**基本信息**：
- 类型：XML/JSON Feed
- 解析库：feedparser（Python）
- 数据源：无限

**免费计划**：
- 请求次数：无限制
- 历史数据：取决于源
- 实时性：取决于源更新频率
- 数据格式：标准化

**推荐源**：
- ✅ **Google News RSS**：https://news.google.com/rss
  - 类别：科技、金融、政治等
  - 更新频率：5-15 分钟
  - 数据量：大

- ✅ **CryptoPanic RSS**：https://cryptopanic.com/news/rss/
  - 类别：加密货币
  - 更新频率：1-5 分钟
  - 数据量：中等

- ✅ **Hacker News API**：https://hacker-news.firebaseio.com/v0/topstories.json
  - 类别：科技
  - 更新频率：实时
  - 数据量：小但高质量

- ✅ **CoinDesk RSS**：https://www.coindesk.com/arc/outboundfeeds/rss/
  - 类别：加密货币
  - 更新频率：1-10 分钟
  - 数据量：中等

**优势**：
- ✅ 完全免费
- ✅ 无速率限制
- ✅ 无需注册
- ✅ 多源聚合无障碍

**限制**：
- ❌ 数据格式不统一（需要标准化）
- ❌ 需要手动去重
- ❌ 搜索功能有限（依赖源）

**适用场景**：
- ✅ 大规模实时监控
- ✅ 多源聚合
- ✅ 成本敏感项目

---

### 3. Brave Search API

**基本信息**：
- 官网：https://brave.com/search/api/
- 类型：Search API
- 搜索引擎：Brave Search

**免费计划**：
- 请求次数：2,000 次/月
- 搜索功能：✅ 支持
- 实时性：✅ 高
- Web 结果：✅ 支持

**付费计划**：
- Developer：$5/月（10,000 次/月）
- Startup：$25/月（50,000 次/月）
- Growth：$125/月（250,000 次/月）

**适用场景**：
- ✅ 需要精确搜索
- ✅ 需要实时新闻
- ❌ 成本敏感（$0.0018/次）

---

## 📊 对比分析

| API | 免费额度 | 速率 | 实时性 | 搜索功能 | 成本 | 推荐度 |
|-----|---------|------|--------|---------|------|--------|
| NewsAPI | 100次/天 | 低 | 高 | ✅ | $0/天 | ⭐⭐⭐ |
| RSS Feeds | 无限制 | 高 | 中-高 | ❌ | $0 | ⭐⭐⭐⭐⭐ |
| Brave Search | 2,000次/月 | 中 | 高 | ✅ | $0.0018/次 | ⭐⭐ |

---

## 🎯 推荐方案

### 主方案：RSS Feeds（免费 + 多源）

**理由**：
1. **完全免费**：无速率限制
2. **多源聚合**：可接入 10+ 个源
3. **实时性高**：部分源 1-5 分钟更新
4. **无障碍**：无需注册和 API Key

**配置**：
```python
RSS_SOURCES = [
    {
        "name": "Google News Tech",
        "url": "https://news.google.com/rss/search?q=tech&hl=en-US&gl=US&ceid=US:en",
        "category": "tech",
        "update_interval": 300  # 5 分钟
    },
    {
        "name": "CryptoPanic",
        "url": "https://cryptopanic.com/news/rss/",
        "category": "crypto",
        "update_interval": 300
    },
    {
        "name": "Hacker News",
        "url": "https://hacker-news.firebaseio.com/v0/topstories.json",
        "category": "tech",
        "update_interval": 180  # 3 分钟
    },
    {
        "name": "CoinDesk",
        "url": "https://www.coindesk.com/arc/outboundfeeds/rss/",
        "category": "crypto",
        "update_interval": 600  # 10 分钟
    },
    {
        "name": "Reuters Technology",
        "url": "https://www.reuters.com/rssFeed/technologyNews",
        "category": "tech",
        "update_interval": 300
    }
]
```

---

### 备用方案：NewsAPI（精确搜索）

**理由**：
1. **搜索功能强**：支持关键词、分类、国家过滤
2. **数据质量高**：30,000+ 官方来源
3. **易于集成**：REST API，返回 JSON

**配置**：
```python
NEWSAPI_CONFIG = {
    "api_key": "YOUR_API_KEY",
    "base_url": "https://newsapi.org/v2",
    "endpoints": {
        "everything": "/everything",
        "top_headlines": "/top-headlines",
        "sources": "/sources"
    },
    "rate_limit": 100  # 100次/天
}
```

**使用策略**：
- RSS 作为主要源（无限制）
- NewsAPI 作为补充（搜索特定事件）
- 每 15 分钟使用一次 NewsAPI（96次/天 < 100限制）

---

### 紧急备用：Brave Search（实时）

**理由**：
1. **实时性最高**：搜索最新网络内容
2. **覆盖面广**：全网搜索
3. **响应快**：Brave 搜索引擎优势

**配置**：
```python
BRAVE_SEARCH_CONFIG = {
    "api_key": "YOUR_API_KEY",
    "base_url": "https://api.search.brave.com/res/v1/web/search",
    "rate_limit": {
        "free": 2000,  # 2,000次/月
        "developer": 10000  # 10,000次/月（$5/月）
    },
    "cost_per_search": 0.0018  # $0.0018/次
}
```

**使用策略**：
- 仅在紧急情况使用（如 RSS 和 NewsAPI 都失败）
- 限制每日用量（如 10 次/天）
- 月成本控制（$0.54/月）

---

## 🚀 实施优先级

### P0（立即实施）
1. **RSS Feeds 集成**（5 个源）
   - 安装 feedparser
   - 实现 RSS 解析逻辑
   - 测试数据获取

### P1（短期优化）
2. **NewsAPI 集成**
   - 注册账号获取 API Key
   - 实现搜索功能
   - 与 RSS 数据聚合

### P2（长期备用）
3. **Brave Search 集成**
   - 评估成本收益
   - 配置紧急备用
   - 监控用量

---

## 📊 预期效果

### RSS Feeds（主方案）
- **事件源数量**：1 → 10+
- **成本**：$0
- **实时性**：1-10 分钟
- **覆盖面**：广（科技 + 加密货币 + 地缘政治）

### NewsAPI（补充方案）
- **搜索精度**：高（关键词 + 分类 + 国家）
- **成本**：$0（免费层）
- **用途**：精确搜索特定事件

### Brave Search（备用方案）
- **实时性**：最高（全网搜索）
- **成本**：$0.54/月（10次/天）
- **用途**：紧急情况

---

## ✅ 结论

**推荐方案**：RSS Feeds（主）+ NewsAPI（补充）

**理由**：
1. RSS Feeds 免费 + 多源，满足主要需求
2. NewsAPI 提供精确搜索，弥补 RSS 不足
3. 总成本 $0，适合长期运行
4. 无需担心速率限制

**下一步**：
1. 集成 RSS Feeds（5 个源）
2. 实现 RSS 解析和数据聚合
3. 测试完整流程

---

**评估完成，准备进入 Phase 1 步骤 2。**
