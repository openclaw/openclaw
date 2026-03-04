#!/usr/bin/env node
/**
 * Polymarket API 认证测试
 * 验证 API Key、Secret、Passphrase 是否有效
 */

const crypto = require('crypto');

// 从环境变量加载密钥
require('dotenv').config({ path: '/home/node/.openclaw/workspace/.secrets/polymarket.env' });

const API_KEY = process.env.POLYMARKET_API_KEY;
const SECRET = process.env.POLYMARKET_SECRET;
const PASSPHRASE = process.env.POLYMARKET_PASSPHRASE;

if (!API_KEY || !SECRET || !PASSPHRASE) {
  console.error('❌ 密钥未正确加载');
  process.exit(1);
}

console.log('✅ 密钥加载成功');
console.log(`API Key: ${API_KEY.substring(0, 8)}...`);
console.log(`Secret: ${SECRET.substring(0, 8)}...`);
console.log(`Passphrase: ${PASSPHRASE.substring(0, 8)}...`);

// 生成签名（Polymarket CLOB API 使用 HMAC-SHA256）
function generateSignature(timestamp, method, requestPath, body = '') {
  const message = timestamp + method + requestPath + body;
  const signature = crypto
    .createHmac('sha256', SECRET)
    .update(message)
    .digest('base64');
  return signature;
}

// 测试 API 调用
async function testAPI() {
  const timestamp = Date.now().toString();
  const method = 'GET';
  const requestPath = '/users/me'; // 获取当前用户信息
  const body = '';

  const signature = generateSignature(timestamp, method, requestPath, body);

  console.log('\n测试 API 认证...');
  console.log(`Timestamp: ${timestamp}`);
  console.log(`Signature: ${signature.substring(0, 20)}...`);

  try {
    const response = await fetch('https://clob.polymarket.com/users/me', {
      method: 'GET',
      headers: {
        'POLY-ACCESS-KEY': API_KEY,
        'POLY-ACCESS-PASSPHRASE': PASSPHRASE,
        'POLY-ACCESS-SIGNATURE': signature,
        'POLY-ACCESS-TIMESTAMP': timestamp,
      },
    });

    const data = await response.json();
    
    if (response.ok) {
      console.log('\n✅ API 认证成功！');
      console.log('用户信息:', JSON.stringify(data, null, 2));
    } else {
      console.log('\n❌ API 认证失败');
      console.log('状态码:', response.status);
      console.log('错误信息:', JSON.stringify(data, null, 2));
    }
  } catch (error) {
    console.error('\n❌ 请求失败:', error.message);
  }
}

testAPI();
