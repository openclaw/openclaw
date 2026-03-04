# Polymarket Sniper - 配置文件

## API 配置

### Polymarket
```python
POLYMARKET_PRIVATE_KEY = os.getenv("POLYMARKET_PRIVATE_KEY")
POLYMARKET_FUNDER_ADDRESS = os.getenv("POLYMARKET_FUNDER_ADDRESS")
CLOB_API_URL = "https://clob.polymarket.com"
GAMMA_API_URL = "https://gamma-api.polymarket.com"
```

### Twitter
```python
# Twitter API v2
TWITTER_BEARER_TOKEN = os.getenv("TWITTER_BEARER_TOKEN")
TWITTER_API_KEY = os.getenv("TWITTER_API_KEY")
TWITTER_API_SECRET = os.getenv("TWITTER_API_SECRET")
TWITTER_ACCESS_TOKEN = os.getenv("TWITTER_ACCESS_TOKEN")
TWITTER_ACCESS_SECRET = os.getenv("TWITTER_ACCESS_SECRET")
```

### NLP API
```python
# 使用 OpenAI 或 GLM
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
GLM_API_KEY = os.getenv("GLM_API_KEY")
```

---

## 交易配置

### 风险管理
```python
MAX_POSITION_PCT = 0.05  # 单笔最大仓位 5%
MAX_DAILY_LOSS_PCT = 0.10  # 单日最大亏损 10%
MIN_CONFIDENCE = 0.70  # 最小置信度
```

### 下注策略
```python
DEFAULT_SIZE = 100  # 默认下注份额
TRADE_DELAY_SECONDS = 30  # 消息后延迟秒数
ORDER_TYPE = "GTC"  # Good Till Cancelled
```

---

## 监控账号

### 政治类
```python
POLITICAL_ACCOUNTS = [
    "realDonaldTrump",
    "POTUS",
    "VP",
    "SpeakerJohnson",
]
```

### 财经类
```python
FINANCIAL_ACCOUNTS = [
    "elonmusk",
    "MichaelSaylor",
    "cz_binance",
    "VitalikButerin",
    "BanklessHQ",
]
```

### 科技类
```python
TECH_ACCOUNTS = [
    "OpenAI",
    "sama",
    "nvidia",
    "Microsoft",
    "Google",
]
```

---

## 日志配置

```python
LOG_FILE = "/tmp/polymarket-sniper.log"
LOG_LEVEL = "INFO"
```

---

## 环境变量检查

```bash
# 检查环境变量
echo $POLYMARKET_PRIVATE_KEY
echo $TWITTER_BEARER_TOKEN
echo $OPENAI_API_KEY

# 如果未设置，需要先配置
```

---

创建时间：2026-03-03 06:20
