'use client';

import { useState } from 'react';
import Link from 'next/link';
import { 
  Zap, 
  Database, 
  MessageSquare, 
  FileSpreadsheet, 
  Shield, 
  Clock,
  CheckCircle,
  ArrowRight,
  Send
} from 'lucide-react';

export default function DataNukePage() {
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<{role: 'user' | 'ai', content: string}[]>([
    { role: 'ai', content: '你好！我是數據核武器 — 專為博弈公司打造的 AI 數據分析師。\n\n試試問我：\n• 「查 VIP3 以上 7 天沒登入的用戶」\n• 「這週存款比上週少多少？」\n• 「多少錢？」' }
  ]);
  const [isTyping, setIsTyping] = useState(false);
  const [apiHistory, setApiHistory] = useState<{role: string, content: string}[]>([]);

  const handleSend = async () => {
    if (!chatInput.trim() || isTyping) return;
    
    const userMessage = chatInput;
    setChatMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    setChatInput('');
    setIsTyping(true);

    try {
      const response = await fetch('/api/data-nuke/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          message: userMessage,
          history: apiHistory 
        }),
      });

      const data = await response.json();
      
      if (data.reply) {
        setChatMessages(prev => [...prev, { role: 'ai', content: data.reply }]);
        if (data.history) {
          setApiHistory(data.history);
        }
      }
    } catch (error) {
      // Fallback response if API fails
      setChatMessages(prev => [...prev, { 
        role: 'ai', 
        content: '抱歉，系統暫時繁忙。請稍後再試，或直接聯繫我們的商務團隊。' 
      }]);
    } finally {
      setIsTyping(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-50">
      {/* Hero Section */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-indigo-600/20 via-slate-900 to-cyan-600/20" />
        <div className="relative max-w-6xl mx-auto px-6 py-24">
          <div className="text-center">
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-500/20 rounded-full text-indigo-300 text-sm mb-6">
              <Zap className="w-4 h-4" />
              iGaming 專屬 AI 數據分析師
            </div>
            <h1 className="text-5xl md:text-6xl font-bold mb-6">
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-cyan-400">
                數據核武器
              </span>
            </h1>
            <p className="text-xl text-slate-300 mb-4 max-w-2xl mx-auto">
              你的數據組 2 天出的報表，我 10 分鐘給你
            </p>
            <p className="text-slate-400 mb-8">
              自然語言查詢 • 秒級響應 • 不用學 SQL
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <a href="#demo" className="inline-flex items-center justify-center gap-2 px-8 py-4 bg-emerald-500 hover:bg-emerald-600 text-white font-semibold rounded-lg transition-colors">
                立即體驗 Demo
                <ArrowRight className="w-5 h-5" />
              </a>
              <a href="#pricing" className="inline-flex items-center justify-center gap-2 px-8 py-4 bg-slate-700 hover:bg-slate-600 text-white font-semibold rounded-lg transition-colors">
                查看價格
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Pain Points */}
      <section className="py-20 bg-slate-800/50">
        <div className="max-w-6xl mx-auto px-6">
          <h2 className="text-3xl font-bold text-center mb-12">你的數據組是不是這樣？</h2>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              { icon: Clock, title: '需求排期 2 天起跳', desc: '運營急著要名單，數據組說「排到下週」' },
              { icon: Database, title: '只有 DBA 會寫 SQL', desc: '想查個數據還要開工單、寫需求文檔' },
              { icon: FileSpreadsheet, title: '報表格式每次都不一樣', desc: '換個人做，格式就變，還要重新核對' },
            ].map((item, i) => (
              <div key={i} className="p-6 bg-slate-800 rounded-xl border border-slate-700">
                <item.icon className="w-10 h-10 text-red-400 mb-4" />
                <h3 className="text-xl font-semibold mb-2">{item.title}</h3>
                <p className="text-slate-400">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Solution */}
      <section className="py-20">
        <div className="max-w-6xl mx-auto px-6">
          <h2 className="text-3xl font-bold text-center mb-4">用中文問，10 分鐘拿結果</h2>
          <p className="text-slate-400 text-center mb-12 max-w-2xl mx-auto">
            不用學 SQL，不用開工單，直接在 Telegram 或微信問我
          </p>
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            {[
              { icon: MessageSquare, title: '自然語言查詢', desc: '「查 VIP3 以上最近沒登入的」' },
              { icon: Zap, title: '秒級響應', desc: '複雜查詢也在 10 分鐘內' },
              { icon: FileSpreadsheet, title: '自動導出', desc: 'Excel / CSV 一鍵下載' },
              { icon: Shield, title: '只讀安全', desc: '不改數據，不存副本' },
            ].map((item, i) => (
              <div key={i} className="p-6 bg-gradient-to-br from-slate-800 to-slate-800/50 rounded-xl border border-slate-700 hover:border-indigo-500/50 transition-colors">
                <item.icon className="w-8 h-8 text-cyan-400 mb-4" />
                <h3 className="text-lg font-semibold mb-2">{item.title}</h3>
                <p className="text-slate-400 text-sm">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Social Proof */}
      <section className="py-20 bg-slate-800/50">
        <div className="max-w-6xl mx-auto px-6">
          <div className="bg-gradient-to-r from-indigo-600/20 to-cyan-600/20 rounded-2xl p-8 md:p-12 border border-indigo-500/30">
            <div className="text-center">
              <p className="text-indigo-300 text-sm mb-4">真實案例</p>
              <h3 className="text-4xl md:text-5xl font-bold mb-4">
                6 分鐘交付 <span className="text-cyan-400">178,686</span> 筆會員名單
              </h3>
              <p className="text-slate-300 text-lg mb-6">
                條件：歷史存款 ≥100，存款筆數 ≥2
              </p>
              <p className="text-slate-400">
                傳統方式需要 1-2 天，我們只用了 6 分鐘
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Interactive Demo */}
      <section id="demo" className="py-20">
        <div className="max-w-4xl mx-auto px-6">
          <h2 className="text-3xl font-bold text-center mb-4">試試看</h2>
          <p className="text-slate-400 text-center mb-8">
            這是 Demo 模式，接入你的數據庫後可查詢真實數據
          </p>
          
          <div className="bg-slate-800 rounded-2xl border border-slate-700 overflow-hidden">
            {/* Chat Header */}
            <div className="px-6 py-4 border-b border-slate-700 flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse" />
              <span className="font-semibold">數據核武器</span>
              <span className="text-slate-400 text-sm">在線</span>
            </div>
            
            {/* Chat Messages */}
            <div className="h-96 overflow-y-auto p-6 space-y-4">
              {chatMessages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] p-4 rounded-2xl whitespace-pre-wrap ${
                    msg.role === 'user' 
                      ? 'bg-indigo-600 text-white' 
                      : 'bg-slate-700 text-slate-100'
                  }`}>
                    {msg.content}
                  </div>
                </div>
              ))}
              {isTyping && (
                <div className="flex justify-start">
                  <div className="bg-slate-700 p-4 rounded-2xl">
                    <div className="flex gap-1">
                      <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{animationDelay: '0ms'}} />
                      <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{animationDelay: '150ms'}} />
                      <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{animationDelay: '300ms'}} />
                    </div>
                  </div>
                </div>
              )}
            </div>
            
            {/* Chat Input */}
            <div className="p-4 border-t border-slate-700">
              <div className="flex gap-3">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleSend()}
                  placeholder="試試問：查 VIP3 以上 7 天沒登入的用戶"
                  className="flex-1 px-4 py-3 bg-slate-700 border border-slate-600 rounded-xl text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-indigo-500"
                />
                <button
                  onClick={handleSend}
                  className="px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl transition-colors flex items-center gap-2"
                >
                  <Send className="w-5 h-5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-20 bg-slate-800/50">
        <div className="max-w-6xl mx-auto px-6">
          <h2 className="text-3xl font-bold text-center mb-4">價格方案</h2>
          <p className="text-slate-400 text-center mb-12">
            一個永遠不請假、不離職、10 分鐘交付的數據分析師
          </p>
          
          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                name: '標準版',
                price: '38,000',
                promo: '首發優惠 ¥30,000',
                features: ['1 個數據源', '無限查詢', 'Telegram / 微信接入', '基礎報表模板', '工作日響應'],
                cta: '聯繫商務',
                featured: false
              },
              {
                name: '專業版',
                price: '58,000',
                promo: null,
                features: ['多數據源', '無限查詢', '自動日報 / 週報', '異常預警通知', '專屬對接群', '7×24 響應'],
                cta: '聯繫商務',
                featured: true
              },
              {
                name: '旗艦版',
                price: '88,000+',
                promo: null,
                features: ['私有部署', '客製化開發', '專屬 AI 調優', '數據不出內網', '專屬技術支援', 'SLA 保障'],
                cta: '預約諮詢',
                featured: false
              }
            ].map((plan, i) => (
              <div key={i} className={`p-8 rounded-2xl border ${
                plan.featured 
                  ? 'bg-gradient-to-b from-indigo-600/20 to-slate-800 border-indigo-500' 
                  : 'bg-slate-800 border-slate-700'
              }`}>
                {plan.featured && (
                  <div className="text-indigo-400 text-sm font-semibold mb-4">最受歡迎</div>
                )}
                <h3 className="text-2xl font-bold mb-2">{plan.name}</h3>
                <div className="mb-6">
                  <span className="text-4xl font-bold">¥{plan.price}</span>
                  <span className="text-slate-400">/月</span>
                  {plan.promo && (
                    <div className="text-emerald-400 text-sm mt-1">{plan.promo}</div>
                  )}
                </div>
                <ul className="space-y-3 mb-8">
                  {plan.features.map((f, j) => (
                    <li key={j} className="flex items-center gap-2 text-slate-300">
                      <CheckCircle className="w-5 h-5 text-emerald-500 flex-shrink-0" />
                      {f}
                    </li>
                  ))}
                </ul>
                <a
                  href="#contact"
                  className={`block text-center py-3 rounded-lg font-semibold transition-colors ${
                    plan.featured
                      ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
                      : 'bg-slate-700 hover:bg-slate-600 text-white'
                  }`}
                >
                  {plan.cta}
                </a>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section id="contact" className="py-20">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <h2 className="text-3xl font-bold mb-4">準備好升級你的數據能力了嗎？</h2>
          <p className="text-slate-400 mb-8">
            留下微信，商務會在 24 小時內聯繫你
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center max-w-md mx-auto">
            <input
              type="text"
              placeholder="你的微信 ID"
              className="flex-1 px-6 py-4 bg-slate-800 border border-slate-700 rounded-xl text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-indigo-500"
            />
            <button className="px-8 py-4 bg-emerald-500 hover:bg-emerald-600 text-white font-semibold rounded-xl transition-colors">
              提交
            </button>
          </div>
          <p className="text-slate-500 text-sm mt-4">
            或直接聯繫：WeChat ID: thinker_cafe
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-8 border-t border-slate-800">
        <div className="max-w-6xl mx-auto px-6 text-center text-slate-400 text-sm">
          <p>© 2026 Thinker Cafe. 數據核武器是 Thinker Cafe 旗下產品。</p>
        </div>
      </footer>
    </div>
  );
}
