#!/usr/bin/env node
/**
 * Polymarket 消息面狙击系统（单次执行版 - v2 修复）
 * 使用 Node.js 内置 https 模块替代 fetch
 */

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');

// 配置
const CONFIG = {
  CLOB_HOST: 'clob.polymarket.com',
  BASE_AMOUNT: 5.0,
  MIN_CONFIDENCE: 0.70,
};

// 加载凭证
function loadCredentials() {
  try {
    const envPath = '/home/node/.openclaw/workspace/config/polymarket.env';
    const envContent = fs.readFileSync(envPath, 'utf8');

    const credentials = {};
    envContent.split('\n').forEach(line => {
      const [key, ...values] = line.split('=');
      if (key && !key.startsWith('#')) {
        credentials[key] = values.join('=').trim();
      }
    });

    return credentials;
  } catch (error) {
    console.error('❌ 加载凭证失败:', error.message);
    process.exit(1);
  }
}

const CREDS = loadCredentials();

// 日志函数
function log(level, message) {
  const timestamp = new Date().toISOString();
  const prefix = {
    'INFO': 'ℹ️',
    'SUCCESS': '✅',
    'WARNING': '⚠️',
    'ERROR': '❌',
    'HEADER': '='
  }[level] || '📋';

  console.log(`${timestamp} - ${prefix} ${message}`);

  fs.appendFileSync('/tmp/polymarket_sniper.log', `${timestamp} - ${prefix} ${message}\n`);
}

// 生成签名
function generateSignature(timestamp, method, requestPath, body = '') {
  const message = timestamp + method + requestPath + body;
  return crypto
    .createHmac('sha256', CREDS.POLYMARKET_SECRET)
    .update(message)
    .digest('base64');
}

// HTTPS 请求封装
function makeRequest(method, path, body = null, authHeaders = true) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: CONFIG.CLOB_HOST,
      port: 443,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      }
    };

    if (authHeaders && CREDS.POLYMARKET_API_KEY) {
      const timestamp = Date.now().toString();
      const signature = generateSignature(timestamp, method, path, body || '');
      options.headers['POLY-ACCESS-KEY'] = CREDS.POLYMARKET_API_KEY;
      options.headers['POLY-ACCESS-PASSPHRASE'] = CREDS.POLYMARKET_PASSPHRASE;
      options.headers['POLY-ACCESS-SIGNATURE'] = signature;
      options.headers['POLY-ACCESS-TIMESTAMP'] = timestamp;
    }

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const jsonData = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(jsonData)}`));
          } else {
            resolve(jsonData);
          }
        } catch (e) {
          reject(new Error(`JSON 解析失败: ${e.message}, 原始数据: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

// 获取市场列表
async function getMarkets() {
  try {
    log('INFO', '获取市场列表...');
    const data = await makeRequest('GET', '/markets');

    let markets = [];
    if (Array.isArray(data)) {
      markets = data;
    } else if (data.data) {
      markets = data.data;
    }

    log('SUCCESS', `获取到 ${markets.length} 个市场`);
    return markets;
  } catch (error) {
    log('ERROR', `获取市场失败: ${error.message}`);
    return [];
  }
}

// 模拟 OSINT 监控
function monitorOSINT() {
  const events = [
    {
      source: 'Twitter',
      account: '@BreakingNews',
      text: 'BREAKING: Iranian naval vessels spotted near Strait of Hormuz',
      keywords: ['Iran', 'Hormuz', 'naval'],
      priority: 'high',
      timestamp: new Date().toISOString()
    }
  ];

  log('INFO', `监控到 ${events.length} 个事件`);
  events.forEach(e => {
    log('INFO', `  - ${e.source}: ${e.text}`);
  });

  return events;
}

// 查找相关市场
function findRelatedMarkets(events, markets) {
  const related = [];

  for (const event of events) {
    for (const market of markets) {
      const question = (market.question || '').toLowerCase();
      const keywords = event.keywords || [];

      const matches = keywords.filter(kw => question.includes(kw.toLowerCase())).length;

      if (matches > 0) {
        related.push({
          event,
          market,
          matches,
          relevance: matches / keywords.length
        });
      }
    }
  }

  related.sort((a, b) => b.relevance - a.relevance);

  log('INFO', `找到 ${related.length} 个相关市场`);
  return related.slice(0, 5);
}

// 分析影响
function analyzeImpact(event, market) {
  const question = (market.question || '').toLowerCase();
  const text = event.text.toLowerCase();

  if (text.includes('iran') && question.includes('hormuz')) {
    return {
      direction: 'YES',
      confidence: 0.85,
      reasoning: 'Iran naval activity increases Hormuz closure probability'
    };
  }

  return null;
}

// 计算动态仓位
function calculatePosition(confidence) {
  if (confidence < CONFIG.MIN_CONFIDENCE) {
    return 0;
  }

  let multiplier = 1.0;
  if (confidence >= 0.80) multiplier = 1.5;
  if (confidence >= 0.90) multiplier = 2.0;
  if (confidence >= 0.95) multiplier = 3.0;

  return CONFIG.BASE_AMOUNT * multiplier;
}

// 执行狙击
async function executeSnipe(market, direction, confidence, reasoning) {
  const amount = calculatePosition(confidence);

  if (amount === 0) {
    log('INFO', '置信度过低，跳过交易');
    return { success: false, reason: 'Confidence too low' };
  }

  log('INFO', `执行狙击: ${market.question.substring(0, 60)}...`);
  log('INFO', `  方向: ${direction}, 金额: ${amount.toFixed(2)} USDC, 置信度: ${(confidence * 100).toFixed(1)}%`);
  log('INFO', `  推理: ${reasoning}`);

  try {
    log('WARNING', '当前为模拟模式，不会执行真实交易');

    const orderId = 'sim_' + Date.now();
    log('SUCCESS', `✅ 模拟订单成功: ${orderId}`);

    return {
      success: true,
      market: market.question,
      direction,
      amount,
      confidence,
      orderId,
      reasoning
    };
  } catch (error) {
    log('ERROR', `狙击失败: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// 主函数（单次执行）
async function runOnce() {
  log('HEADER', '============================================================');
  log('HEADER', '🎯 Polymarket 消息面狙击系统（v2 修复版）');
  log('HEADER', '============================================================');
  log('INFO', `地址: ${CREDS.POLYMARKET_ADDRESS}`);
  log('INFO', `执行时间: ${new Date().toISOString()}`);

  try {
    // 1. 监控 OSINT
    const events = monitorOSINT();

    // 2. 获取市场
    const markets = await getMarkets();

    if (markets.length === 0) {
      log('WARNING', '无市场数据，退出');
      return;
    }

    // 3. 查找相关市场
    const related = findRelatedMarkets(events, markets);

    if (related.length === 0) {
      log('INFO', '未找到相关市场，退出');
      return;
    }

    // 显示前 3 个相关市场
    log('INFO', '前 3 个相关市场:');
    related.slice(0, 3).forEach((item, i) => {
      log('INFO', `  ${i + 1}. [${item.market.question.substring(0, 50)}...] 相关性: ${(item.relevance * 100).toFixed(0)}%`);
    });

    // 4. 分析和执行
    let snipedCount = 0;
    for (const item of related) {
      const impact = analyzeImpact(item.event, item.market);

      if (impact && impact.confidence >= CONFIG.MIN_CONFIDENCE) {
        const result = await executeSnipe(
          item.market,
          impact.direction,
          impact.confidence,
          impact.reasoning
        );

        if (result.success) {
          snipedCount++;
          log('SUCCESS', `✅ 狙击成功 #${snipedCount}`);
        }
      } else if (impact) {
        log('INFO', `  跳过: 置信度 ${(impact.confidence * 100).toFixed(1)}% < 阈值 ${(CONFIG.MIN_CONFIDENCE * 100).toFixed(0)}%`);
      }
    }

    // 总结
    log('HEADER', '------------------------------------------------------------');
    log('HEADER', '执行总结');
    log('HEADER', '------------------------------------------------------------');
    log('INFO', `扫描事件: ${events.length}`);
    log('INFO', `相关市场: ${related.length}`);
    log('INFO', `执行狙击: ${snipedCount}`);

    if (snipedCount === 0) {
      log('INFO', '本次未执行任何狙击操作');
    }

  } catch (error) {
    log('ERROR', `运行错误: ${error.message}`);
    process.exit(1);
  }
}

// 启动
runOnce().then(() => {
  log('HEADER', '============================================================');
  log('HEADER', '✅ 执行完成，退出');
  log('HEADER', '============================================================');
  process.exit(0);
}).catch(error => {
  log('ERROR', `系统启动失败: ${error.message}`);
  process.exit(1);
});
