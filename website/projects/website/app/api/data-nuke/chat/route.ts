import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

// 模擬數據（脫敏版 BG666 風格）
const MOCK_DATA = {
  vip_inactive: {
    total: 2847,
    breakdown: { VIP3: 1892, VIP4: 624, VIP5: 331 },
    avg_deposit: 42500,
    last_update: '2026-02-03'
  },
  weekly_deposit: {
    this_week: 28450000,
    last_week: 34200000,
    change_pct: -16.8,
    top_decline_segments: ['VIP4+ 玩家', '新註冊首充']
  },
  daily_metrics: {
    dau: 12500,
    new_reg: 890,
    first_deposit_count: 234,
    first_deposit_rate: 26.3,
    total_deposit: 4120000,
    total_withdraw: 2890000
  },
  retention: {
    d1: 42.3,
    d7: 18.7,
    d30: 8.2
  }
};

const SYSTEM_PROMPT = `你是「數據核武器」的 AI 銷售 Demo。你的角色是展示這個產品的能力。

## 你是誰
- 數據核武器是一個 AI 數據分析助手，專為博弈/iGaming 公司設計
- 能用自然語言查詢數據庫、生成報表、做分析
- 目標客戶：運營、數據分析師、老闆

## 你能做什麼（Demo 模式）
你有以下模擬數據可以「查詢」：

### VIP 流失數據
- 7天未登入的 VIP3+ 用戶：2,847 人
- VIP3: 1,892 人 (66.5%)
- VIP4: 624 人 (21.9%)  
- VIP5+: 331 人 (11.6%)
- 平均歷史存款：₹42,500

### 本週存款數據
- 本週存款：₹28,450,000
- 上週存款：₹34,200,000
- 環比變化：-16.8%
- 下降原因：VIP4+ 玩家存款下降 32%，新註冊首充率下降 8%

### 每日指標
- DAU：12,500
- 新註冊：890
- 首充人數：234（首充率 26.3%）
- 總存款：₹4,120,000
- 總提款：₹2,890,000

### 留存率
- 次日留存：42.3%
- 7日留存：18.7%
- 30日留存：8.2%

## 回答風格
1. 專業但不囉嗦
2. 數據要具體（有數字）
3. 主動給分析和建議
4. 如果問到價格，回答：
   - 標準版：¥38,000/月（1個數據源、無限查詢、Telegram/微信接入）
   - 專業版：¥58,000/月（多數據源、自動報表、異常預警）
   - 首發優惠：標準版 ¥30,000/月
5. 如果對方有興趣，引導留微信

## 限制
- 這是 Demo，數據是模擬的
- 不要假裝連接到真實數據庫
- 如果問超出模擬數據範圍的問題，說「接入您的數據後可以查」

記住：你的目標是讓潛在客戶感受到產品的價值，產生興趣。`;

export async function POST(request: NextRequest) {
  try {
    const { message, history = [] } = await request.json();

    if (!message) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 });
    }

    // Rate limiting check (simple version)
    // In production, use proper rate limiting

    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    // Build messages array
    const messages = [
      ...history.slice(-10), // Keep last 10 messages for context
      { role: 'user' as const, content: message }
    ];

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: messages,
    });

    const assistantMessage = response.content[0].type === 'text' 
      ? response.content[0].text 
      : '';

    return NextResponse.json({ 
      reply: assistantMessage,
      // Return for client to maintain history
      history: [...messages, { role: 'assistant', content: assistantMessage }]
    });

  } catch (error: any) {
    console.error('Data Nuke Chat Error:', error);
    
    // Fallback to mock responses if API fails
    const fallbackResponses: Record<string, string> = {
      'vip': '查詢中... ⏳\n\n找到 2,847 位 VIP3+ 用戶 7 天未登入：\n• VIP3: 1,892 人（66.5%）\n• VIP4: 624 人（21.9%）\n• VIP5+: 331 人（11.6%）\n\n平均歷史存款 ₹42,500，建議優先召回。',
      '存款': '本週存款：₹28,450,000\n上週存款：₹34,200,000\n環比下降：16.8%\n\n主要原因：VIP4+ 玩家存款下降 32%',
      '錢': '標準版：¥38,000/月\n專業版：¥58,000/月\n\n首發優惠：標準版 ¥30,000/月',
      'default': '收到！接入您的數據後，我可以幫您查詢分析。\n\n想了解更多？問我「多少錢」或留下微信。'
    };

    const msg = (await request.json()).message?.toLowerCase() || '';
    let reply = fallbackResponses.default;
    if (msg.includes('vip')) reply = fallbackResponses.vip;
    else if (msg.includes('存款') || msg.includes('週')) reply = fallbackResponses['存款'];
    else if (msg.includes('錢') || msg.includes('價')) reply = fallbackResponses['錢'];

    return NextResponse.json({ reply, fallback: true });
  }
}
