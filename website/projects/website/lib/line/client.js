import { Client } from '@line/bot-sdk';

/**
 * LINE Bot Client
 * 用於發送訊息給用戶
 */

// 初始化 LINE Bot Client
export function createLineClient() {
  const config = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
  };

  // 驗證必要的環境變數
  if (!config.channelAccessToken) {
    throw new Error('LINE_CHANNEL_ACCESS_TOKEN is not set');
  }
  if (!config.channelSecret) {
    throw new Error('LINE_CHANNEL_SECRET is not set');
  }

  return new Client(config);
}

/**
 * 驗證 Webhook Signature
 * @param {string} body - Request body (原始字串)
 * @param {string} signature - X-Line-Signature header
 * @returns {boolean}
 */
export function validateSignature(body, signature) {
  const crypto = require('crypto');
  const channelSecret = process.env.LINE_CHANNEL_SECRET;

  const hash = crypto
    .createHmac('SHA256', channelSecret)
    .update(body)
    .digest('base64');

  return hash === signature;
}
