#!/usr/bin/env node
/**
 * Polymarket 消息面狙击系统（v3 - 修复 TLS 问题）
 * 使用 curl 获取数据，Node.js 处理逻辑
 */

const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');

// 配置
const CONFIG = {
  CLOB_HOST: 'https://clob.polymarket.com',
  BASE_AMOUNT: 5.0,
  MIN_CONFIDENCE: 0.70,
  MARKETS_CACHE: '/tmp/polymarket_markets.json'
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

// 使用 curl 获取市场数据
function getMarketsViaCurl() {
  try {
    log('INFO', '使用 curl 获取市场列表...');
    
    execSync(`curl -s --max-time 30 "${CONFIG.CLOB_HOST}/markets" -o ${CONFIG.MARKETS_CACHE}`, {
      timeout: 35000
    });
    
    const data = JSON.parse(fs.readFileSync(CONFIG.MARKETS_CACHE, 'utf8'));
    const markets = data.data || data || [];
    
    log('SUCCESS', `获取到 ${markets.length} 个市场`);
    return markets;
  } catch (error) {
    log('ERROR', `获取市场失败: ${error.message}`);
    return [];
  }
}

// 真实 OSINT 监控（从多个来源获取新闻）
async function monitorOSINT() {
  const events = [];
  
  // 1. 尝试从 NewsAPI 获取（如果有配置）
  // 2. 尝试从 Twitter 获取（如果有配置）
  // 3. 使用模拟数据作为后备
  
  // 模拟事件（实际应该从真实 API 获取）
  const simulatedEvents = [
    {
      source: 'News',
      text: 'Iran warns of response to Israeli strikes',
      keywords: ['Iran', 'Israel', 'war', 'strike'],
      priority: 'high',
      timestamp: new Date().toISOString()
    },
    {
      source: 'Twitter',
      text: 'BREAKING: US Treasury announces new sanctions on Russia',
      keywords: ['Russia', 'sanctions', 'US', 'Treasury'],
      priority: 'high',
      timestamp: new Date().toISOString()
    },
    {
      source: 'Reuters',
      text: 'Federal Reserve signals potential rate cuts in 2024',
      keywords: ['Fed', 'Federal Reserve', 'rate', 'interest'],
      priority: 'medium',
      timestamp: new Date().toISOString()
    }
  ];
  
  events.push(...simulatedEvents);
  
  log('INFO', `监控到 ${events.length} 个事件`);
  events.forEach(e => {
    log('INFO', `  - [${e.priority.toUpperCase()}] ${e.source}: ${e.text.substring(0, 60)}...`);
  });
  
  return events;
}

// 查找相关市场
function findRelatedMarkets(events, markets) {
  const related = [];
  
  for (const event of events) {
    for (const market of markets) {
      const question = (market.question || '').toLowerCase();
      const description = (market.description || '').toLowerCase();
      const keywords = event.keywords || [];
      
      // 检查关键词匹配
      let matches = 0;
      for (const kw of keywords) {
        if (question.includes(kw.toLowerCase()) || description.includes(kw.toLowerCase())) {
          matches++;
        }
      }
      
      if (matches > 0) {
        related.push({
          event,
          market,
          matches,
          relevance: matches / keywords.length,
          isAcceptingOrders: market.accepting_orders && market.active && !market.closed
        });
      }
    }
  }
  
  // 按相关性和是否接受订单排序
  related.sort((a, b) => {
    // 优先选择可交易的市场
    if (a.isAcceptingOrders !== b.isAcceptingOrders) {
      return b.isAcceptingOrders - a.isAcceptingOrders;
    }
    return b.relevance - a.relevance;
  });
  
  log('INFO', `找到 ${related.length} 个相关市场`);
  
  // 统计可交易市场
  const tradeable = related.filter(r => r.isAcceptingOrders);
  log('INFO', `  其中 ${tradeable.length} 个可交易（accepting_orders=true）`);
  
  return related.slice(0, 10);
}

// 分析影响
function analyzeImpact(event, market) {
  const question = (market.question || '').toLowerCase();
  const text = event.text.toLowerCase();
  
  // Iran 相关
  if (text.includes('iran') && (question.includes('iran') || question.includes('hormuz'))) {
    return {
      direction: 'YES',
      confidence: 0.75,
      reasoning: 'Iran tensions may affect related prediction markets'
    };
  }
  
  // Russia 相关
  if (text.includes('russia') && text.includes('sanctions') && question.includes('russia')) {
    return {
      direction: 'YES',
      confidence: 0.70,
      reasoning: 'New sanctions on Russia may affect related markets'
    };
  }
  
  // Fed 相关
  if ((text.includes('fed') || text.includes('federal reserve')) && 
      (question.includes('rate') || question.includes('interest'))) {
    return {
      direction: 'YES',
      confidence: 0.65,
      reasoning: 'Fed policy signals may affect rate prediction markets'
    };
  }
  
  // 通用匹配
  if (event.priority === 'high') {
    return {
      direction: 'YES',
      confidence: 0.60,
      reasoning: 'High priority event with keyword match'
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

// 主函数
async function main() {
  log('HEADER', '============================================================');
  log('HEADER', '🎯 Polymarket 消息面狙击系统（v3 - curl 版本）');
  log('HEADER', '============================================================');
  log('INFO', `地址: ${CREDS.POLYMARKET_ADDRESS}`);
  log('INFO', `执行时间: ${new Date().toISOString()}`);
  
  try {
    // 1. 监控 OSINT
    const events = await monitorOSINT();
    
    // 2. 获取市场
    const markets = getMarketsViaCurl();
    
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
    
    // 显示相关市场
    log('INFO', '相关市场:');
    related.slice(0, 5).forEach((item, i) => {
      const status = item.isAcceptingOrders ? '🟢 可交易' : '🔴 已关闭';
      log('INFO', `  ${i + 1}. ${status} [${(item.relevance * 100).toFixed(0)}%] ${item.market.question.substring(0, 50)}...`);
    });
    
    // 4. 分析和执行
    let snipedCount = 0;
    let skippedCount = 0;
    
    for (const item of related) {
      // 跳过不可交易的市场
      if (!item.isAcceptingOrders) {
        log('INFO', `  跳过: 市场已关闭`);
        skippedCount++;
        continue;
      }
      
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
        skippedCount++;
      }
    }
    
    // 总结
    log('HEADER', '------------------------------------------------------------');
    log('HEADER', '执行总结');
    log('HEADER', '------------------------------------------------------------');
    log('INFO', `扫描事件: ${events.length}`);
    log('INFO', `市场总数: ${markets.length}`);
    log('INFO', `相关市场: ${related.length}`);
    log('INFO', `已关闭: ${skippedCount}`);
    log('INFO', `执行狙击: ${snipedCount}`);
    
    if (snipedCount === 0) {
      log('INFO', '本次未执行任何狙击操作（可能无可交易市场或置信度不足）');
    }
    
    return {
      eventsScanned: events.length,
      marketsTotal: markets.length,
      relatedMarkets: related.length,
      snipedCount,
      skippedCount
    };
    
  } catch (error) {
    log('ERROR', `运行错误: ${error.message}`);
    log('ERROR', error.stack);
    process.exit(1);
  }
}

// 启动
main().then((result) => {
  log('HEADER', '============================================================');
  log('HEADER', '✅ 执行完成，退出');
  log('HEADER', '============================================================');
  process.exit(0);
}).catch(error => {
  log('ERROR', `系统启动失败: ${error.message}`);
  process.exit(1);
});
