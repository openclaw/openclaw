import { Resend } from 'resend';

// Resend API Key (hardcoded fallback for Vercel deployment)
const RESEND_API_KEY = process.env.RESEND_API_KEY || 're_XSmZmgqn_2H4cCRRxGgG3LdSrhmmRCis8';

// Email 寄件者 (hardcoded fallback for Vercel deployment)
export const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'onboarding@updates.thinker.cafe';

// Email 寄件者顯示名稱
export const FROM_NAME = '思考者咖啡 Thinker Cafe';

// 完整的寄件者格式
export const FROM = `${FROM_NAME} <${FROM_EMAIL}>`;

// Initialize Resend client
export const resend = new Resend(RESEND_API_KEY);
